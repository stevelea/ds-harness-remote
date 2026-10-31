import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECT_CAPABILITY,
  DIRECT_HEARTBEAT_INTERVAL_MS,
  DIRECT_PROTOCOL_VERSION,
  MAX_DIRECT_FRAME_BYTES,
  SecureMessageCodec,
  createDirectFrame,
  createRpcResponse,
  decodeDirectFrame,
  decodeMessage,
  encodeMessage,
  type DirectDataPayload,
  type DirectFrame,
  type DirectHandshakePayload,
  type DirectHelloPayload,
  type RemoteMessage,
} from '@dsh-remote/protocol'
import { NoiseIkSession, createNoisePrologue, generateKeyPair, fromBase64Url, toBase64Url, type KeyPair } from '@dsh-remote/crypto'
import type { DirectWebSocket } from '@dsh-remote/webrtc'
import { AndroidRemoteConnection } from '../src/services/connection'
import type { DeviceIdentity, RemoteDevice } from '../src/types'

/**
 * In-memory Direct host: implements the tiny `direct.*` server side the real
 * Host plugin exposes (hello/ready, Noise IK step 2, encrypted rpc responses)
 * so the Android client path is exercised without a network or a Server.
 */
class FakeDirectSocket implements DirectWebSocket {
  readyState = 0
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  peer?: FakeDirectSocket
  closed = false

  send(data: string): void {
    const peer = this.peer
    if (peer === undefined || peer.closed) return
    queueMicrotask(() => {
      if (!peer.closed && peer.readyState === 1) peer.onmessage?.({ data })
    })
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    const self = this
    queueMicrotask(() => self.onclose?.({ code, reason }))
    const peer = this.peer
    if (peer !== undefined && !peer.closed) {
      peer.closed = true
      peer.readyState = 3
      queueMicrotask(() => peer.onclose?.({ code, reason }))
    }
  }
}

interface FakeHostOptions {
  hostKeys: KeyPair
  clientPublicKey: string
  hostDeviceId: string
  readyHostDeviceId?: string
}

class FakeDirectHost {
  readonly hellos: string[] = []
  readonly appMessageTypes: string[] = []
  private noise?: NoiseIkSession
  private connectionId?: string
  private inboundCounter = 0
  private outboundCounter = 0
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()

  constructor(private readonly socket: FakeDirectSocket, private readonly options: FakeHostOptions) {
    socket.onmessage = event => this.receive(String(event.data))
  }

  private receive(raw: string): void {
    let frame: DirectFrame
    try {
      frame = decodeDirectFrame(raw)
    } catch {
      return
    }
    if (frame.type === 'direct.hello') {
      const payload = frame.payload as DirectHelloPayload
      this.hellos.push(payload.clientDeviceId)
      this.connectionId = payload.connectionId
      this.noise = new NoiseIkSession({
        role: 'responder',
        localPrivateKey: this.options.hostKeys.privateKey,
        localPublicKey: this.options.hostKeys.publicKey,
        remotePublicKey: this.options.clientPublicKey,
        prologue: createNoisePrologue(payload.connectionId, this.options.hostDeviceId, payload.clientDeviceId),
      })
      this.send('direct.ready', {
        connectionId: payload.connectionId,
        hostDeviceId: this.options.readyHostDeviceId ?? this.options.hostDeviceId,
        hostName: 'Test Host',
        protocol: DIRECT_PROTOCOL_VERSION,
        capabilities: [DIRECT_CAPABILITY, 'harness.api.v1'],
        maxFrameBytes: MAX_DIRECT_FRAME_BYTES,
        heartbeatIntervalMs: DIRECT_HEARTBEAT_INTERVAL_MS,
      })
      return
    }
    if (frame.type === 'direct.handshake') {
      const payload = frame.payload as DirectHandshakePayload
      const noise = this.noise
      if (noise === undefined || payload.step !== 1 || payload.connectionId !== this.connectionId) return
      noise.readHandshake(fromBase64Url(payload.data))
      this.send('direct.handshake', {
        connectionId: this.connectionId,
        step: 2,
        data: toBase64Url(noise.writeHandshake()),
      })
      return
    }
    if (frame.type === 'direct.data') {
      const payload = frame.payload as DirectDataPayload
      const noise = this.noise
      if (noise === undefined || payload.counter !== this.inboundCounter) return
      this.inboundCounter += 1
      this.receivePlaintext(noise.decrypt(fromBase64Url(payload.ciphertext)))
      return
    }
    if (frame.type === 'direct.ping') {
      this.send('direct.pong', {})
    }
  }

  private receivePlaintext(ciphertext: Uint8Array): void {
    const plaintext = this.incoming.decode(ciphertext)
    if (plaintext === undefined) return
    let message: RemoteMessage
    try {
      message = decodeMessage(plaintext)
    } catch {
      return
    }
    this.appMessageTypes.push(message.type)
    if (message.type !== 'rpc.request') return
    const payload = message.payload as { method: string }
    const result = payload.method === 'harness.transport.describe'
      ? { capabilities: ['harness.remote.v1'] }
      : {}
    this.sendPlain(createRpcResponse(message.id, result))
  }

  private sendPlain(message: RemoteMessage): void {
    const noise = this.noise
    const connectionId = this.connectionId
    if (noise === undefined || connectionId === undefined) return
    for (const fragment of this.outgoing.encode(encodeMessage(message))) {
      this.send('direct.data', {
        connectionId,
        counter: this.outboundCounter,
        ciphertext: toBase64Url(noise.encrypt(fragment)),
      } satisfies DirectDataPayload)
      this.outboundCounter += 1
    }
  }

  private send(type: Parameters<typeof createDirectFrame>[0], payload: unknown): void {
    this.socket.send(JSON.stringify(createDirectFrame(type, payload)))
  }
}

interface DirectFixture {
  identity: DeviceIdentity
  host: RemoteDevice
  webSocketFactory: (url: string) => DirectWebSocket
  servers: FakeDirectHost[]
}

function createFixture(options: { readyHostDeviceId?: string } = {}): DirectFixture {
  const clientKeys = generateKeyPair(new Uint8Array(32).fill(7))
  const hostKeys = generateKeyPair(new Uint8Array(32).fill(9))
  const identity: DeviceIdentity = {
    deviceId: '11111111-1111-4111-8111-111111111111',
    name: 'Android',
    platform: 'android',
    publicKey: clientKeys.publicKey,
    privateKey: clientKeys.privateKey,
  }
  const host: RemoteDevice = {
    deviceId: '22222222-2222-4222-8222-222222222222',
    name: 'Host',
    platform: 'darwin',
    identityKey: hostKeys.publicKey,
    membershipId: 'membership-1',
    online: true,
    trusted: true,
  }
  const servers: FakeDirectHost[] = []
  const webSocketFactory = (url: string): DirectWebSocket => {
    expect(url.startsWith('ws://') || url.startsWith('wss://')).toBe(true)
    const client = new FakeDirectSocket()
    const server = new FakeDirectSocket()
    client.peer = server
    server.peer = client
    server.readyState = 1
    servers.push(new FakeDirectHost(server, {
      hostKeys,
      clientPublicKey: clientKeys.publicKey,
      hostDeviceId: host.deviceId,
      ...(options.readyHostDeviceId === undefined ? {} : { readyHostDeviceId: options.readyHostDeviceId }),
    }))
    queueMicrotask(() => {
      if (client.closed) return
      client.readyState = 1
      client.onopen?.({})
    })
    return client
  }
  return { identity, host, webSocketFactory, servers }
}

describe('Android direct connection', () => {
  const connections: AndroidRemoteConnection[] = []

  beforeEach(() => {
    // Teardown closes the carrier while stream-close RPCs are still in flight.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(connection => connection.close().catch(() => undefined)))
    vi.restoreAllMocks()
  })

  function connection(): AndroidRemoteConnection {
    const created = new AndroidRemoteConnection()
    connections.push(created)
    return created
  }

  it('connects over the direct socket, runs Noise IK and probes the Host capabilities', async () => {
    const fixture = createFixture()
    const target = connection()
    const factory = vi.fn(fixture.webSocketFactory)

    await target.connectDirect('100.64.0.12:47400', fixture.identity, fixture.host, () => undefined, {
      directWebSocketFactory: factory,
    })

    // The WebSocket path comes from DirectTransport.endpointUrl, not user input.
    expect(factory).toHaveBeenCalledWith('ws://100.64.0.12:47400/direct/v1')
    expect(target.getStats()).toMatchObject({ mode: 'Direct', connected: true })
    const details = await target.getNetworkDetails()
    expect(details?.controlChannelUrl).toBe('ws://100.64.0.12:47400/direct/v1')
    expect(details?.webRtcEnabled).toBe(false)
    expect(details?.preferredTransports).toEqual([])
    // One hello, one Noise step 1 and encrypted capability probes only.
    expect(fixture.servers[0]!.hellos).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(fixture.servers[0]!.appMessageTypes).toContain('rpc.request')

    await target.close()
    expect(target.getStats()?.connected ?? false).toBe(false)
  })

  it('fails closed when direct.ready does not echo the pinned Host device id', async () => {
    const fixture = createFixture({ readyHostDeviceId: '33333333-3333-4333-8333-333333333333' })
    const target = connection()

    await expect(target.connectDirect(
      '100.64.0.12:47400',
      fixture.identity,
      fixture.host,
      () => undefined,
      { directWebSocketFactory: fixture.webSocketFactory },
    )).rejects.toThrow()

    // No encrypted application frame may be exchanged after a mismatched ready.
    expect(fixture.servers[0]!.appMessageTypes).toEqual([])
    expect(target.getStats()?.connected ?? false).toBe(false)
  })

  it('refuses to open a socket without a trusted pinned Host key or a tailnet target', async () => {
    const fixture = createFixture()
    const factory = vi.fn(fixture.webSocketFactory)
    const target = connection()
    const missingKey: RemoteDevice = { ...fixture.host, identityKey: '' }
    const untrusted: RemoteDevice = { ...fixture.host, trusted: false }

    await expect(target.connectDirect('100.64.0.12:47400', fixture.identity, missingKey, () => undefined, {
      directWebSocketFactory: factory,
    })).rejects.toThrow()
    await expect(target.connectDirect('100.64.0.12:47400', fixture.identity, untrusted, () => undefined, {
      directWebSocketFactory: factory,
    })).rejects.toThrow()
    await expect(target.connectDirect('8.8.8.8:47400', fixture.identity, fixture.host, () => undefined, {
      directWebSocketFactory: factory,
    })).rejects.toThrow()

    expect(factory).not.toHaveBeenCalled()
    expect(target.getStats()?.connected ?? false).toBe(false)
  })
})
