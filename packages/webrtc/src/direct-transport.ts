import {
  DIRECT_CAPABILITY,
  DIRECT_HEARTBEAT_INTERVAL_MS,
  DIRECT_IDLE_TIMEOUT_MS,
  DIRECT_PROTOCOL_VERSION,
  DIRECT_WS_PATH,
  MAX_DIRECT_FRAME_BYTES,
  createDirectFrame,
  decodeDirectFrame,
  encodeDirectFrame,
  type DirectClosePayload,
  type DirectDataPayload,
  type DirectHandshakePayload,
  type DirectHelloPayload,
  type DirectPingPayload,
  type DirectReadyPayload,
  type DirectFrame,
  type DirectRejectPayload,
  type TransportStats,
} from '@dsh-remote/protocol'
import { BaseTransport, type SecureHandshakeTransport } from './transport.js'
import { fromBase64Url, socketText, toBase64Url } from './util.js'
import { waitForRelayCapacity } from './websocket-backpressure.js'

/** Minimal WebSocket face shared by browsers, React Native and Node 22+. */
export interface DirectWebSocket {
  readonly readyState: number
  readonly bufferedAmount?: number
  binaryType: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface DirectTransportOptions {
  /** Local Client device id; bound into the Noise prologue by the caller. */
  deviceId: string
  /** Pinned Host device id; `direct.ready` must echo it. */
  hostDeviceId: string
  clientVersion?: string
  capabilities?: string[]
  /** Bound for the `direct.hello` -> `direct.ready` exchange. */
  helloTimeoutMs?: number
  heartbeatIntervalMs?: number
  idleTimeoutMs?: number
  signal?: AbortSignal
  /** Test seam; defaults to the global WebSocket constructor. */
  webSocketFactory?: (url: string) => DirectWebSocket
}

export interface DirectConnectionDetails {
  connectionId?: string
  connectedAt?: number
  heartbeatIntervalMs?: number
  lastReceivedAt?: number
  endpoint: string
  socketState: 'connecting' | 'open' | 'closing' | 'closed'
  hostDeviceId: string
  hostName?: string
  capabilities: string[]
}

const DEFAULT_CAPABILITIES = [DIRECT_CAPABILITY, 'harness.api.v1'] as const
const CONNECT_TIMEOUT_MS = 10_000

/**
 * Client-side Direct (Tailscale) transport: a serverless WebSocket to a Host
 * that listens on tailnet addresses only.
 *
 * The transport exchanges `direct.hello`/`direct.ready`, relays the Noise IK
 * handshake frames, then carries opaque Noise ciphertext in `direct.data`
 * frames. It never trusts the Hello/Ready claim for identity: the peer is
 * authenticated by the Noise IK transcript and the pinned Host key that the
 * caller supplies to the secure channel wrapper.
 */
export class DirectTransport extends BaseTransport implements SecureHandshakeTransport {
  private readonly handshakeHandlers = new Set<(step: number, data: Uint8Array) => void>()
  private socket?: DirectWebSocket
  private connectionId?: string
  private hostName?: string
  private negotiatedCapabilities: string[] = []
  private maxFrameBytes = MAX_DIRECT_FRAME_BYTES
  private heartbeatIntervalMs = DIRECT_HEARTBEAT_INTERVAL_MS
  private idleTimeoutMs = DIRECT_IDLE_TIMEOUT_MS
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private idleTimer?: ReturnType<typeof setInterval>
  private helloTimer?: ReturnType<typeof setTimeout>
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private lifetime?: AbortController
  private closeNotified = false
  private connected = false
  private connectedAt?: number
  private lastReceivedAt?: number
  private inboundCounter = 0
  private outboundCounter = 0
  private bytesSent = 0
  private bytesReceived = 0

  constructor(
    private readonly url: string,
    private readonly options: DirectTransportOptions,
  ) {
    super()
  }

  static endpointUrl(endpoint: string): string {
    const trimmed = endpoint.trim()
    if (trimmed.length === 0) throw new Error('A Direct host address is required.')
    let normalized = trimmed
    if (/^wss?:\/\//i.test(normalized)) { /* already a WebSocket URL */ }
    else if (/^https:\/\//i.test(normalized)) normalized = normalized.replace(/^https:/i, 'wss:')
    else normalized = `ws://${normalized}`
    const url = new URL(normalized)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('A Direct host address must use ws, wss or https.')
    if (url.pathname === '' || url.pathname === '/') url.pathname = DIRECT_WS_PATH
    else if (url.pathname !== DIRECT_WS_PATH) throw new Error(`A Direct host address must not include a path other than ${DIRECT_WS_PATH}.`)
    if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new Error('A Direct host address must not include credentials, query parameters or a fragment.')
    }
    return url.toString()
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return
    const lifetime = new AbortController()
    this.lifetime = lifetime
    this.resetState()
    const socket = this.createSocket(this.url)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.helloTimer = setTimeout(
        () => this.failConnection(Object.assign(new Error('The Direct Host did not answer in time.'), { code: 'DIRECT_TIMEOUT' })),
        this.options.helloTimeoutMs ?? CONNECT_TIMEOUT_MS,
      )
      const onAbort = () => this.failConnection(Object.assign(new Error('The Direct connection was aborted.'), { code: 'CANCELLED' }))
      this.options.signal?.addEventListener('abort', onAbort, { once: true })
      this.removeAbort = () => this.options.signal?.removeEventListener('abort', onAbort)
      socket.onopen = () => {
        if (this.lifetime !== lifetime) return
        try {
          this.sendFrame(createDirectFrame('direct.hello', {
            connectionId: this.requireConnectionId(),
            clientDeviceId: this.options.deviceId,
            ...(this.options.clientVersion === undefined ? {} : { clientVersion: this.options.clientVersion }),
            capabilities: [...(this.options.capabilities ?? DEFAULT_CAPABILITIES)],
          } satisfies DirectHelloPayload))
        } catch (error) {
          this.failConnection(asError(error))
        }
      }
      socket.onmessage = event => { void this.handleSocketMessage(event.data, lifetime) }
      socket.onerror = () => {
        // Do not fail here: the close event carries the Host's reason and arrives
        // immediately after an error. If no close arrives, the hello timer fails.
        if (this.lifetime === lifetime && this.connected) {
          this.failConnection(Object.assign(new Error('The Direct transport failed.'), { code: 'DIRECT_CLOSED' }))
        }
      }
      socket.onclose = event => {
        if (this.lifetime !== lifetime) return
        const reason = typeof event.reason === 'string' ? event.reason.trim() : ''
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)
          ? reason
          : this.connected ? 'DIRECT_CLOSED' : 'DIRECT_CONNECT_FAILED'
        this.failConnection(Object.assign(new Error('The Direct Host closed the connection.'), {
          code,
          closeCode: event.code,
        }))
      }
    })
  }

  async send(data: Uint8Array): Promise<void> {
    const socket = this.requireSocket()
    await waitForRelayCapacity(socket)
    const payload = {
      connectionId: this.requireConnectionId(),
      counter: this.outboundCounter,
      ciphertext: toBase64Url(data),
    } satisfies DirectDataPayload
    this.sendFrame(createDirectFrame('direct.data', payload))
    this.outboundCounter += 1
    this.bytesSent += data.byteLength
  }

  async sendHandshake(step: number, data: Uint8Array): Promise<void> {
    if (step !== 1) throw new Error('The Direct initiator only sends Noise IK step 1.')
    this.sendFrame(createDirectFrame('direct.handshake', {
      connectionId: this.requireConnectionId(),
      step: 1,
      data: toBase64Url(data),
    } satisfies DirectHandshakePayload))
  }

  onHandshake(cb: (step: number, data: Uint8Array) => void): () => void {
    this.handshakeHandlers.add(cb)
    return () => this.handshakeHandlers.delete(cb)
  }

  connectionInfo(): { connectionId: string; localDeviceId: string; remoteDeviceId: string } {
    return {
      connectionId: this.requireConnectionId(),
      localDeviceId: this.options.deviceId,
      remoteDeviceId: this.options.hostDeviceId,
    }
  }

  async connectionDetails(): Promise<DirectConnectionDetails> {
    return {
      ...(this.connectionId === undefined ? {} : { connectionId: this.connectionId }),
      ...(this.connectedAt === undefined ? {} : { connectedAt: this.connectedAt }),
      ...(this.lastReceivedAt === undefined ? {} : { lastReceivedAt: this.lastReceivedAt }),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      endpoint: this.url,
      socketState: socketState(this.socket?.readyState),
      hostDeviceId: this.options.hostDeviceId,
      ...(this.hostName === undefined ? {} : { hostName: this.hostName }),
      capabilities: [...this.negotiatedCapabilities],
    }
  }

  getStats(): TransportStats {
    return {
      mode: 'Direct',
      connected: this.connected && this.socket?.readyState === 1,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
    }
  }

  async close(): Promise<void> {
    this.failConnection(Object.assign(new Error('The Direct transport was closed.'), { code: 'CANCELLED', silent: true }))
  }

  private removeAbort?: () => void

  private async handleSocketMessage(data: unknown, lifetime: AbortController): Promise<void> {
    if (this.lifetime !== lifetime) return
    try {
      const frame = decodeDirectFrame(await socketText(data as string | ArrayBuffer), this.maxFrameBytes)
      this.lastReceivedAt = Date.now()
      if (frame.type === 'direct.ready') {
        this.handleReady(frame.payload as Partial<DirectReadyPayload>)
        return
      }
      if (frame.type === 'direct.reject') {
        const payload = frame.payload as Partial<DirectRejectPayload>
        throw Object.assign(new Error(
          typeof payload.message === 'string' ? payload.message : 'The Direct Host rejected the connection.',
        ), {
          code: typeof payload.code === 'string' ? payload.code : 'DIRECT_REJECTED',
          retryable: payload.retryable,
        })
      }
      if (this.connectionId === undefined) throw new Error('Received a Direct frame before direct.ready.')
      if (frame.type === 'direct.handshake') {
        const payload = frame.payload as Partial<DirectHandshakePayload>
        if (payload.connectionId !== this.connectionId || payload.step !== 2 || typeof payload.data !== 'string') {
          throw new Error('Received an invalid Direct handshake frame.')
        }
        const handshake = fromBase64Url(payload.data)
        for (const handler of this.handshakeHandlers) handler(2, handshake)
        return
      }
      if (frame.type === 'direct.data') {
        const payload = frame.payload as Partial<DirectDataPayload>
        if (payload.connectionId !== this.connectionId
          || !Number.isSafeInteger(payload.counter)
          || payload.counter !== this.inboundCounter
          || typeof payload.ciphertext !== 'string') {
          throw new Error('Received a Direct data frame with an invalid counter.')
        }
        const ciphertext = fromBase64Url(payload.ciphertext)
        this.inboundCounter += 1
        this.bytesReceived += ciphertext.byteLength
        this.emit(ciphertext)
        return
      }
      if (frame.type === 'direct.ping') {
        this.sendFrame(createDirectFrame('direct.pong', frame.payload as DirectPingPayload))
        return
      }
      if (frame.type === 'direct.pong') return
      if (frame.type === 'direct.close') {
        const payload = frame.payload as Partial<DirectClosePayload>
        throw Object.assign(new Error(
          typeof payload.message === 'string' ? payload.message : 'The Direct Host closed the connection.',
        ), { code: typeof payload.code === 'string' ? payload.code : 'DIRECT_CLOSED' })
      }
      throw new Error('Received an unsupported Direct frame.')
    } catch (error) {
      this.failConnection(Object.assign(asError(error), { code: (error as { code?: string }).code ?? 'INVALID_MESSAGE' }))
    }
  }

  private handleReady(payload: Partial<DirectReadyPayload>): void {
    if (this.connectionId === undefined || this.connected) throw new Error('Received an unexpected direct.ready.')
    if (payload.connectionId !== this.connectionId
      || payload.hostDeviceId !== this.options.hostDeviceId
      || payload.protocol !== DIRECT_PROTOCOL_VERSION
      || !Array.isArray(payload.capabilities)
      || !payload.capabilities.includes(DIRECT_CAPABILITY)
      || !Number.isSafeInteger(payload.maxFrameBytes)
      || (payload.maxFrameBytes as number) <= 0
      || (payload.maxFrameBytes as number) > MAX_DIRECT_FRAME_BYTES
      || !Number.isSafeInteger(payload.heartbeatIntervalMs)
      || (payload.heartbeatIntervalMs as number) <= 0) {
      throw new Error('The Direct Host returned an unexpected handshake response.')
    }
    this.maxFrameBytes = payload.maxFrameBytes as number
    this.heartbeatIntervalMs = Math.min(payload.heartbeatIntervalMs as number, DIRECT_IDLE_TIMEOUT_MS)
    this.idleTimeoutMs = this.options.idleTimeoutMs ?? Math.max(DIRECT_IDLE_TIMEOUT_MS, this.heartbeatIntervalMs * 3)
    this.hostName = typeof payload.hostName === 'string' ? payload.hostName : undefined
    this.negotiatedCapabilities = [...payload.capabilities]
    this.connected = true
    this.connectedAt = Date.now()
    this.lastReceivedAt = this.connectedAt
    this.clearHelloTimer()
    this.startHeartbeat()
    const resolve = this.readyResolve
    this.readyResolve = undefined
    this.readyReject = undefined
    resolve?.()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendFrame(createDirectFrame('direct.ping', {}))
      } catch {
        // A failed ping is reported by the socket close/failure path.
      }
    }, this.heartbeatIntervalMs)
    this.idleTimer = setInterval(() => {
      if (this.lastReceivedAt === undefined) return
      if (Date.now() - this.lastReceivedAt > this.idleTimeoutMs) {
        this.failConnection(Object.assign(new Error('The Direct connection stopped responding.'), {
          code: 'DIRECT_IDLE_TIMEOUT',
          retryable: true,
        }))
      }
    }, Math.max(1_000, Math.floor(this.heartbeatIntervalMs / 2)))
    // Node keeps the process alive for an interval; do not hold a CLI/plugin
    // process open on the carrier alone. Browsers have no unref.
    for (const timer of [this.heartbeatTimer, this.idleTimer]) {
      (timer as unknown as { unref?: () => void } | undefined)?.unref?.()
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.heartbeatTimer = undefined
    this.idleTimer = undefined
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    this.helloTimer = undefined
  }

  private sendFrame(frame: DirectFrame): void {
    const socket = this.requireSocket()
    socket.send(encodeDirectFrame(frame, this.maxFrameBytes))
  }

  private requireSocket(): DirectWebSocket {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) throw new Error('The Direct transport is not connected.')
    return socket
  }

  private requireConnectionId(): string {
    const connectionId = this.connectionId
    if (connectionId === undefined) throw new Error('The Direct transport has not sent direct.hello yet.')
    return connectionId
  }

  private createSocket(url: string): DirectWebSocket {
    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory
    const socket = factory(url)
    socket.binaryType = 'arraybuffer'
    return socket
  }

  private resetState(): void {
    this.readyResolve = undefined
    this.readyReject = undefined
    this.connectionId = randomConnectionId()
    this.hostName = undefined
    this.negotiatedCapabilities = []
    this.maxFrameBytes = MAX_DIRECT_FRAME_BYTES
    this.heartbeatIntervalMs = DIRECT_HEARTBEAT_INTERVAL_MS
    this.idleTimeoutMs = DIRECT_IDLE_TIMEOUT_MS
    this.inboundCounter = 0
    this.outboundCounter = 0
    this.bytesSent = 0
    this.bytesReceived = 0
    this.closeNotified = false
    this.connected = false
    this.connectedAt = undefined
    this.lastReceivedAt = undefined
  }

  private failConnection(error: Error): void {
    const silent = (error as { silent?: boolean }).silent === true
    const lifetime = this.lifetime
    this.lifetime = undefined
    this.clearHelloTimer()
    this.stopHeartbeat()
    this.removeAbort?.()
    this.removeAbort = undefined
    const socket = this.socket
    this.socket = undefined
    this.connected = false
    if (socket !== undefined) {
      try {
        const failureCode = (error as { code?: unknown }).code
        if (socket.readyState === 1) socket.send(encodeDirectFrame(createDirectFrame('direct.close', {
          code: typeof failureCode === 'string' ? failureCode : 'DIRECT_CLOSED',
        } satisfies DirectClosePayload)))
      } catch { /* best effort */ }
      try { socket.close(1000) } catch { /* ignore */ }
    }
    const reject = this.readyReject
    this.readyResolve = undefined
    this.readyReject = undefined
    if (reject !== undefined) {
      reject(error)
      return
    }
    if (lifetime !== undefined && !silent) this.notifyClose(error)
  }

  private notifyClose(error: Error | undefined): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.emitClose(error)
  }
}

function socketState(readyState: number | undefined): 'connecting' | 'open' | 'closing' | 'closed' {
  if (readyState === 0) return 'connecting'
  if (readyState === 1) return 'open'
  if (readyState === 2) return 'closing'
  return 'closed'
}

function defaultWebSocketFactory(url: string): DirectWebSocket {
  const constructor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket
  if (constructor === undefined) throw new Error('This runtime has no WebSocket implementation for the Direct transport.')
  return new constructor(url) as DirectWebSocket
}

/**
 * The protocol binds `connectionId` into the Noise prologue and audits it as a
 * UUID/ULID. React Native's Hermes may lack `crypto.randomUUID`, so fall back to
 * `getRandomValues` with a UUIDv4-shaped value.
 */
export function randomConnectionId(): string {
  const crypto = globalThis.crypto
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (crypto?.getRandomValues !== undefined) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('The Direct transport failed.')
}
