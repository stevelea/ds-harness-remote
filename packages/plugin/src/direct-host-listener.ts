import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { NoiseIkSession, createNoisePrologue, fromBase64Url, toBase64Url } from '@dsh-remote/crypto'
import {
  DIRECT_CAPABILITY,
  DIRECT_HANDSHAKE_TIMEOUT_MS,
  DIRECT_HEARTBEAT_INTERVAL_MS,
  DIRECT_HELLO_TIMEOUT_MS,
  DIRECT_IDLE_TIMEOUT_MS,
  DIRECT_PROTOCOL_VERSION,
  DIRECT_WS_PATH,
  MAX_DIRECT_ACTIVE_CONNECTIONS,
  MAX_DIRECT_FRAME_BYTES,
  MAX_DIRECT_PENDING_HANDSHAKES,
  SecureMessageCodec,
  createDirectFrame,
  decodeDirectFrame,
  decodeMessage,
  encodeDirectFrame,
  encodeMessage,
  type DirectClosePayload,
  type DirectDataPayload,
  type DirectHandshakePayload,
  type DirectHelloPayload,
  type DirectPingPayload,
  type DirectReadyPayload,
  type DirectRejectPayload,
  type DirectFrameType,
  type RemoteMessage,
} from '@dsh-remote/protocol'
import type { HostIdentity, IdentityStore, TrustedPeer } from './identity-store.js'
import type { SafeLogger } from './logging.js'
import type { AuthenticatedPeerChannel } from './types.js'
import { detectTailscale, isBindableDirectAddress, type TailscaleStatus } from './direct-tailscale.js'

/** Opt-in serverless Host listener for the Direct (Tailscale) transport. */
export interface DirectHostListenerOptions {
  identity: HostIdentity
  identities: IdentityStore
  logger: SafeLogger
  port: number
  /** Accept an authenticated channel into the Host connection controller. */
  accept: (channel: AuthenticatedPeerChannel) => Promise<void>
  /** Test seam; defaults to Tailscale auto-detection for `port`. */
  detect?: () => Promise<TailscaleStatus>
  /** Test seam; binds these addresses instead of the detected tailnet addresses. */
  bindAddresses?: string[]
  /** Remove the logical connection from the Host controller when the carrier closes. */
  closeConnection?: (connectionId: string, code?: string) => void | Promise<void>
}

export interface DirectHostStatus {
  /** True when `direct.enabled` is configured; `running` says whether it bound. */
  enabled: boolean
  running: boolean
  port: number
  endpoints: string[]
  bindAddresses: string[]
  activeConnections: number
  pendingHandshakes: number
  tailscale: {
    detected: boolean
    source: TailscaleStatus['source']
    backendState?: string
    hostName?: string
    dnsName?: string
    error?: string
  }
  error?: string
}

const HOST_PLATFORM = process.platform

/**
 * Binds a WebSocket listener only to Tailscale addresses detected locally.
 *
 * The listener is opt-in (`direct.enabled`) and never binds a wildcard or a
 * public address: every address must classify as a tailnet address (loopback is
 * accepted only for local tests). A Client is rejected before Noise starts
 * unless its device id is already pinned by the normal Server authorization;
 * the channel is handed to the Host runtime only after Noise IK completes for
 * this exact socket and the pinned identity key matched.
 */
export class DirectHostListener {
  private servers: Server[] = []
  private wsServers: WebSocketServer[] = []
  private sockets = new Set<Duplex>()
  private sessions = new Set<DirectSession>()
  private tailscale: TailscaleStatus = { detected: false, addresses: [], endpoints: [], source: 'none' }
  private bindAddresses: string[] = []
  private endpoints: string[] = []
  private lastError?: string
  private running = false
  private closed = false

  constructor(private readonly options: DirectHostListenerOptions) {}

  async start(): Promise<void> {
    if (this.running || this.closed) return
    this.lastError = undefined
    try {
      this.tailscale = await (this.options.detect ?? (() => detectTailscale({ port: this.options.port })))()
    } catch {
      this.tailscale = { detected: false, addresses: [], endpoints: [], source: 'none', error: 'TAILSCALE_DETECTION_FAILED' }
    }
    const addresses = this.options.bindAddresses ?? this.tailscale.addresses.map(item => item.address)
    if (addresses.length === 0) {
      this.lastError = this.tailscale.error ?? 'TAILSCALE_NOT_DETECTED'
      return
    }
    const bound: string[] = []
    for (const address of addresses) {
      if (!isBindableDirectAddress(address)) {
        this.lastError = 'DIRECT_ADDRESS_NOT_TAILNET'
        continue
      }
      try {
        await this.bindAddress(address)
        bound.push(address)
      } catch {
        this.lastError = 'DIRECT_BIND_FAILED'
        this.options.logger.warn('Direct listener bind failed', { code: 'DIRECT_BIND_FAILED' })
      }
    }
    this.bindAddresses = bound
    this.running = bound.length > 0
    this.endpoints = bound.length === 0
      ? []
      : this.options.bindAddresses === undefined
        ? (this.tailscale.endpoints.length > 0 ? this.tailscale.endpoints : bound.map(address => formatEndpoint(address, this.options.port)))
        : bound.map(address => formatEndpoint(address, this.options.port))
    if (!this.running) {
      this.lastError ??= 'DIRECT_BIND_FAILED'
      this.options.logger.warn('Direct listener is unavailable', { code: 'DIRECT_UNAVAILABLE' })
      return
    }
    this.options.logger.info('Direct Tailscale listener ready', {
      port: this.options.port,
      endpointCount: this.endpoints.length,
      source: this.tailscale.source,
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    this.running = false
    for (const session of [...this.sessions]) session.shutdown()
    this.sessions.clear()
    for (const socket of [...this.sockets]) {
      try { socket.destroy() } catch { /* ignore */ }
    }
    this.sockets.clear()
    const wsServers = this.wsServers
    const servers = this.servers
    this.wsServers = []
    this.servers = []
    await Promise.allSettled([
      ...wsServers.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
      ...servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
    ])
  }

  status(): DirectHostStatus {
    return {
      enabled: true,
      running: this.running,
      port: this.options.port,
      endpoints: [...this.endpoints],
      bindAddresses: [...this.bindAddresses],
      activeConnections: [...this.sessions].filter(session => session.isReady()).length,
      pendingHandshakes: [...this.sessions].filter(session => session.isPending()).length,
      tailscale: {
        detected: this.tailscale.detected,
        source: this.tailscale.source,
        ...(this.tailscale.backendState === undefined ? {} : { backendState: this.tailscale.backendState }),
        ...(this.tailscale.hostName === undefined ? {} : { hostName: this.tailscale.hostName }),
        ...(this.tailscale.dnsName === undefined ? {} : { dnsName: this.tailscale.dnsName }),
        ...(this.tailscale.error === undefined ? {} : { error: this.tailscale.error }),
      },
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  trustedPeer(deviceId: string): TrustedPeer | undefined {
    return this.options.identities.trustedPeer(deviceId)
  }

  get identity(): HostIdentity { return this.options.identity }
  get logger(): SafeLogger { return this.options.logger }
  get port(): number { return this.options.port }
  get acceptChannel(): (channel: AuthenticatedPeerChannel) => Promise<void> { return this.options.accept }

  sessionClosed(session: DirectSession): void {
    this.sessions.delete(session)
  }

  notifyCarrierClosed(connectionId: string, code?: string): void {
    try {
      void this.options.closeConnection?.(connectionId, code)?.catch?.(() => undefined)
    } catch {
      // The controller is already unreachable when the Host is shutting down.
    }
  }

  canAccept(): boolean {
    const sessions = [...this.sessions]
    if (sessions.length >= MAX_DIRECT_ACTIVE_CONNECTIONS + MAX_DIRECT_PENDING_HANDSHAKES) return false
    return sessions.filter(item => item.isPending()).length < MAX_DIRECT_PENDING_HANDSHAKES
  }

  private async bindAddress(address: string): Promise<void> {
    const server = createServer()
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_DIRECT_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    })
    server.on('upgrade', (request, socket, head) => {
      const path = request.url?.split('?')[0]
      if (path === undefined || !path.endsWith(DIRECT_WS_PATH)) {
        socket.destroy()
        return
      }
      try {
        wss.handleUpgrade(request, socket, head, ws => {
          if (this.closed || !this.canAccept()) {
            try { ws.close(1013, 'DIRECT_BUSY') } catch { /* ignore */ }
            return
          }
          const session = new DirectSession(this, ws)
          this.sessions.add(session)
          session.start()
        })
      } catch {
        try { socket.destroy() } catch { /* ignore */ }
      }
    })
    server.on('request', (_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
      response.end('Not Found')
    })
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('error', () => {
      this.options.logger.warn('Direct listener socket error', { code: 'DIRECT_SOCKET_ERROR' })
    })
    server.on('clientError', (_error, socket) => {
      try { (socket as Duplex).destroy() } catch { /* ignore */ }
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.removeListener('listening', onListening); reject(error) }
      const onListening = (): void => { server.removeListener('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host: address, port: this.options.port, exclusive: true })
    })
    this.servers.push(server)
    this.wsServers.push(wss)
  }
}

export class DirectSession {
  private phase: 'hello' | 'handshake' | 'ready' | 'closed' = 'hello'
  private trusted?: TrustedPeer
  private noise?: NoiseIkSession
  private channel?: DirectNoiseChannel
  private connectionId?: string
  private inboundCounter = 0
  private lastReceivedAt = Date.now()
  private helloTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private idleTimer?: ReturnType<typeof setInterval>

  constructor(private readonly listener: DirectHostListener, private readonly ws: WebSocket) {}

  get id(): string | undefined { return this.connectionId }

  isPending(): boolean { return this.phase === 'hello' || this.phase === 'handshake' }
  isReady(): boolean { return this.phase === 'ready' }

  start(): void {
    this.ws.on('message', (data: RawData, isBinary: boolean) => this.onRawMessage(data, isBinary))
    this.ws.on('close', () => this.destroy())
    this.ws.on('error', () => this.destroy())
    this.helloTimer = setTimeout(
      () => this.closeWith('DIRECT_TIMEOUT', 'The Direct hello did not arrive in time.'),
      DIRECT_HELLO_TIMEOUT_MS,
    )
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.sendFrame('direct.ping', {}), DIRECT_HEARTBEAT_INTERVAL_MS)
    this.idleTimer = setInterval(() => this.checkIdle(), Math.max(1_000, Math.floor(DIRECT_HEARTBEAT_INTERVAL_MS / 2)))
  }

  shutdown(): void { this.destroy() }

  private onRawMessage(data: RawData, isBinary: boolean): void {
    if (this.phase === 'closed' || isBinary) {
      if (this.phase !== 'closed') this.closeWith('DIRECT_INVALID_FRAME', 'Only text Direct frames are accepted.')
      return
    }
    this.lastReceivedAt = Date.now()
    let frame
    try {
      frame = decodeDirectFrame(rawDataToString(data), MAX_DIRECT_FRAME_BYTES)
    } catch {
      this.closeWith('DIRECT_INVALID_FRAME', 'The Direct frame is invalid.')
      return
    }
    switch (frame.type) {
      case 'direct.close':
        this.terminate(typeof frame.payload === 'object' && frame.payload !== null
          ? (frame.payload as DirectClosePayload).code
          : undefined)
        return
      case 'direct.ping':
        this.sendFrame('direct.pong', frame.payload as DirectPingPayload)
        return
      case 'direct.pong':
        return
      default:
        break
    }
    if (this.phase === 'hello') {
      if (frame.type !== 'direct.hello') { this.closeWith('DIRECT_INVALID_FRAME', 'Expected direct.hello.'); return }
      this.onHello(frame.payload as DirectHelloPayload)
      return
    }
    if (this.phase === 'handshake') {
      if (frame.type !== 'direct.handshake') { this.closeWith('DIRECT_INVALID_FRAME', 'Expected direct.handshake.'); return }
      void this.onHandshake(frame.payload as DirectHandshakePayload)
      return
    }
    if (frame.type !== 'direct.data') { this.closeWith('DIRECT_INVALID_FRAME', 'Expected direct.data.'); return }
    this.onData(frame.payload as DirectDataPayload)
  }

  private onHello(payload: DirectHelloPayload): void {
    const trust = this.listener.trustedPeer(payload.clientDeviceId)
    if (trust === undefined) {
      this.closeWith('DIRECT_TRUST_REQUIRED', 'This Client is not trusted by the Host yet; authorize it through the Server first.')
      return
    }
    this.clearHelloTimer()
    this.connectionId = payload.connectionId
    this.trusted = trust
    try {
      this.noise = new NoiseIkSession({
        role: 'responder',
        localPrivateKey: this.listener.identity.privateKey,
        localPublicKey: this.listener.identity.publicKey,
        remotePublicKey: trust.publicKey,
        prologue: createNoisePrologue(payload.connectionId, this.listener.identity.deviceId, trust.deviceId),
      })
    } catch {
      this.closeWith('DIRECT_HANDSHAKE_FAILED', 'The Direct Noise handshake could not start.')
      return
    }
    this.phase = 'handshake'
    this.handshakeTimer = setTimeout(
      () => this.closeWith('DIRECT_HANDSHAKE_FAILED', 'The Direct Noise handshake timed out.'),
      DIRECT_HANDSHAKE_TIMEOUT_MS,
    )
    this.sendFrame('direct.ready', {
      connectionId: payload.connectionId,
      hostDeviceId: this.listener.identity.deviceId,
      hostName: this.listener.identity.name,
      hostPlatform: HOST_PLATFORM,
      protocol: DIRECT_PROTOCOL_VERSION,
      capabilities: [DIRECT_CAPABILITY],
      maxFrameBytes: MAX_DIRECT_FRAME_BYTES,
      heartbeatIntervalMs: DIRECT_HEARTBEAT_INTERVAL_MS,
    } satisfies DirectReadyPayload)
  }

  private async onHandshake(payload: DirectHandshakePayload): Promise<void> {
    const noise = this.noise
    const trusted = this.trusted
    const connectionId = this.connectionId
    if (noise === undefined || trusted === undefined || connectionId === undefined
      || payload.connectionId !== connectionId || payload.step !== 1) {
      this.closeWith('DIRECT_HANDSHAKE_FAILED', 'Unexpected Direct Noise handshake message.')
      return
    }
    try {
      noise.readHandshake(fromBase64Url(payload.data))
      const reply = noise.writeHandshake()
      if (!noise.complete) throw new Error('Noise IK did not complete.')
      const channel = new DirectNoiseChannel(this, noise, trusted, connectionId)
      this.channel = channel
      await this.listener.acceptChannel(channel)
      if (this.phase === 'closed') return
      this.clearHandshakeTimer()
      this.phase = 'ready'
      this.startHeartbeat()
      this.sendFrame('direct.handshake', {
        connectionId,
        step: 2,
        data: toBase64Url(reply),
      } satisfies DirectHandshakePayload)
      this.listener.logger.debug('Direct peer channel ready', {
        connectionId: shortDirectId(connectionId),
        peerDeviceId: shortDirectId(trusted.deviceId),
      })
    } catch {
      this.closeWith('DIRECT_HANDSHAKE_FAILED', 'The Direct Noise handshake failed.')
    }
  }

  private onData(payload: DirectDataPayload): void {
    const channel = this.channel
    if (channel === undefined || payload.connectionId !== this.connectionId) {
      this.closeWith('DIRECT_INVALID_FRAME', 'Unexpected Direct data frame.')
      return
    }
    try {
      channel.receive(payload.counter, fromBase64Url(payload.ciphertext))
    } catch {
      this.closeWith('DIRECT_SECURE_CHANNEL_FAILED', 'The Direct secure channel rejected a data frame.')
    }
  }

  sendCiphertext(ciphertext: Uint8Array): void {
    const noise = this.noise
    const connectionId = this.connectionId
    if (noise === undefined || connectionId === undefined || this.phase !== 'ready') throw new Error('The Direct channel is not ready.')
    const counter = Number(noise.sendingCounter() - 1n)
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('The Direct transport counter overflowed.')
    this.sendFrame('direct.data', {
      connectionId,
      counter,
      ciphertext: toBase64Url(ciphertext),
    } satisfies DirectDataPayload)
  }

  assertInboundCounter(counter: number, noise: NoiseIkSession): void {
    const expected = Number(noise.receivingCounter())
    if (!Number.isSafeInteger(counter) || counter !== expected || counter !== this.inboundCounter) {
      throw new Error('The Direct data frame counter is duplicated or out of order.')
    }
    this.inboundCounter += 1
  }

  private checkIdle(): void {
    if (this.phase === 'closed') return
    if (Date.now() - this.lastReceivedAt > DIRECT_IDLE_TIMEOUT_MS) {
      this.closeWith('DIRECT_IDLE_TIMEOUT', 'The Direct connection stopped responding.', true)
    }
  }

  private closeWith(code: string, message: string, retryable = false): void {
    if (this.phase === 'closed') return
    // Flush the reason frame before the WebSocket close handshake: a refused
    // Client must see DIRECT_TRUST_REQUIRED / DIRECT_HANDSHAKE_FAILED, not a
    // generic socket error. A safety timer covers a send callback that never fires.
    const finish = (): void => this.destroy(code)
    if (this.phase === 'ready') {
      this.sendFrame('direct.close', { code } satisfies DirectClosePayload, finish)
    } else {
      this.sendFrame('direct.reject', { code, message, retryable } satisfies DirectRejectPayload, finish)
    }
    const timer = setTimeout(finish, 500)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    if (this.ws.readyState !== WebSocket.OPEN) finish()
  }

  private terminate(code?: string): void {
    if (code !== undefined && this.phase === 'ready') {
      this.sendFrame('direct.close', { code } satisfies DirectClosePayload, () => this.destroy(code))
      return
    }
    this.destroy()
  }

  private destroy(closeReason?: string): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.clearTimers()
    const channel = this.channel
    this.channel = undefined
    void channel?.close().catch(() => undefined)
    if (this.noise !== undefined) {
      this.noise.destroy()
      this.noise = undefined
    }
    this.listener.sessionClosed(this)
    const closedConnectionId = this.connectionId
    if (closedConnectionId !== undefined) this.listener.notifyCarrierClosed(closedConnectionId, 'CONNECTION_FAILED')
    try { this.ws.close(closeReason === undefined ? 1000 : 1008, closeReason) } catch { /* ignore */ }
  }

  private sendFrame(type: DirectFrameType, payload: unknown, afterFlush?: () => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      afterFlush?.()
      return
    }
    try {
      this.ws.send(encodeDirectFrame(createDirectFrame(type, payload), MAX_DIRECT_FRAME_BYTES), () => afterFlush?.())
    } catch {
      afterFlush?.()
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    this.helloTimer = undefined
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  private clearTimers(): void {
    this.clearHelloTimer()
    this.clearHandshakeTimer()
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.heartbeatTimer = undefined
    this.idleTimer = undefined
  }
}

/** Authenticated Noise channel handed to the Host connection controller. */
class DirectNoiseChannel implements AuthenticatedPeerChannel {
  readonly security
  readonly peerDeviceId: string
  readonly peerIdentityKey: string
  readonly mode = 'Direct' as const
  private readonly handlers = new Set<(message: RemoteMessage) => void>()
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()
  private sendTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly session: DirectSession,
    private readonly noise: NoiseIkSession,
    private readonly trusted: TrustedPeer,
    connectionId: string,
  ) {
    this.security = {
      protocol: 'Noise_IK_25519_ChaChaPoly_SHA256' as const,
      connectionId,
      membershipId: `direct:${trusted.deviceId}`,
    }
    this.peerDeviceId = trusted.deviceId
    this.peerIdentityKey = trusted.publicKey
  }

  send(message: RemoteMessage): Promise<void> {
    const run = this.sendTail.then(() => this.sendNow(message))
    this.sendTail = run.catch(() => undefined)
    return run
  }

  private async sendNow(message: RemoteMessage): Promise<void> {
    if (this.closed) throw new Error('The Direct channel is closed.')
    const encoded = encodeMessage(message)
    for (const plaintext of this.outgoing.encode(encoded)) {
      this.session.sendCiphertext(this.noise.encrypt(plaintext))
    }
  }

  onMessage(handler: (message: RemoteMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  receive(counter: number, ciphertext: Uint8Array): void {
    if (this.closed) return
    this.session.assertInboundCounter(counter, this.noise)
    const plaintext = this.incoming.decode(this.noise.decrypt(ciphertext))
    if (plaintext === undefined) return
    const message = decodeMessage(plaintext)
    for (const handler of this.handlers) handler(message)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.handlers.clear()
    this.incoming.reset()
    this.outgoing.reset()
    this.noise.destroy()
    this.session.shutdown()
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

function formatEndpoint(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`
}

function shortDirectId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}
