import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECT_CAPABILITY,
  DIRECT_PROTOCOL_VERSION,
  DIRECT_WS_PATH,
  createDirectFrame,
  decodeDirectFrame,
  encodeDirectFrame,
  type DirectFrame,
  type DirectHelloPayload,
} from '@dsh-remote/protocol'
import { DirectTransport, type DirectWebSocket } from '../src/direct-transport.js'

const deviceId = '01942c3e-0a51-7000-8000-000000000002'
const hostDeviceId = '01942c3e-0a51-7000-8000-000000000003'
const hostName = 'studio.tail1234.ts.net'

class FakeSocket implements DirectWebSocket {
  readyState = 0
  bufferedAmount = 0
  binaryType = 'arraybuffer'
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }

  deliver(frame: DirectFrame): void {
    this.onmessage?.({ data: encodeDirectFrame(frame) })
  }

  deliverRaw(data: string): void {
    this.onmessage?.({ data })
  }

  frames(): DirectFrame[] {
    return this.sent.map(value => decodeDirectFrame(value))
  }
}

function setup(options: { heartbeatIntervalMs?: number; idleTimeoutMs?: number } = {}): { socket: FakeSocket; transport: DirectTransport; hellos: () => DirectHelloPayload[] } {
  const socket = new FakeSocket()
  const transport = new DirectTransport(`ws://100.100.1.2:47400${DIRECT_WS_PATH}`, {
    deviceId,
    hostDeviceId,
    ...options,
    webSocketFactory: () => socket,
  })
  const hellos = (): DirectHelloPayload[] => socket.frames().filter(frame => frame.type === 'direct.hello').map(frame => frame.payload as DirectHelloPayload)
  return { socket, transport, hellos }
}

/** DirectTransport delivers socket messages through an async handler; flush microtasks before asserting. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

async function connected(options: { heartbeatIntervalMs?: number; idleTimeoutMs?: number } = {}): Promise<{ socket: FakeSocket; transport: DirectTransport }> {
  const setupResult = setup(options)
  const promise = setupResult.transport.connect()
  setupResult.socket.open()
  const hello = setupResult.hellos()[0]!
  setupResult.socket.deliver(createDirectFrame('direct.ready', {
    connectionId: hello.connectionId,
    hostDeviceId,
    hostName,
    hostPlatform: 'darwin',
    protocol: DIRECT_PROTOCOL_VERSION,
    capabilities: [DIRECT_CAPABILITY],
    maxFrameBytes: 1024 * 1024,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25_000,
  }))
  await promise
  return setupResult
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DirectTransport.endpointUrl', () => {
  it.each([
    ['100.100.1.2:47400', `ws://100.100.1.2:47400${DIRECT_WS_PATH}`],
    ['studio.tail1234.ts.net:47400', `ws://studio.tail1234.ts.net:47400${DIRECT_WS_PATH}`],
    ['ws://100.100.1.2:47400', `ws://100.100.1.2:47400${DIRECT_WS_PATH}`],
    ['https://studio.tail1234.ts.net', `wss://studio.tail1234.ts.net${DIRECT_WS_PATH}`],
  ])('normalizes %s', (input, expected) => {
    expect(DirectTransport.endpointUrl(input)).toBe(expected)
  })

  it.each([[''], ['https://host/direct/v1?token=1'], ['user:pass@100.100.1.2:47400'], ['ftp://100.100.1.2:47400']])('rejects %s', input => {
    expect(() => DirectTransport.endpointUrl(input)).toThrow()
  })
})

describe('DirectTransport client handshake', () => {
  it('sends direct.hello and accepts a matching direct.ready', async () => {
    const { socket, transport, hellos } = setup()
    const promise = transport.connect()
    socket.open()
    const hello = hellos()[0]!
    expect(hello.clientDeviceId).toBe(deviceId)
    expect(hello.capabilities).toContain(DIRECT_CAPABILITY)
    expect(transport.getStats()).toEqual({ mode: 'Direct', connected: false, bytesSent: 0, bytesReceived: 0 })

    socket.deliver(createDirectFrame('direct.ready', {
      connectionId: hello.connectionId,
      hostDeviceId,
      hostName,
      protocol: DIRECT_PROTOCOL_VERSION,
      capabilities: [DIRECT_CAPABILITY],
      maxFrameBytes: 1024 * 1024,
      heartbeatIntervalMs: 25_000,
    }))
    await promise
    expect(transport.connectionInfo()).toEqual({ connectionId: hello.connectionId, localDeviceId: deviceId, remoteDeviceId: hostDeviceId })
    expect(transport.getStats()).toMatchObject({ mode: 'Direct', connected: true })
    await transport.close()
  })

  it('rejects a direct.ready for a different pinned host id', async () => {
    const { socket, transport, hellos } = setup()
    const promise = transport.connect()
    socket.open()
    socket.deliver(createDirectFrame('direct.ready', {
      connectionId: hellos()[0]!.connectionId,
      hostDeviceId: '01942c3e-0a51-7000-8000-0000000000ff',
      hostName,
      protocol: DIRECT_PROTOCOL_VERSION,
      capabilities: [DIRECT_CAPABILITY],
      maxFrameBytes: 1024 * 1024,
      heartbeatIntervalMs: 25_000,
    }))
    await expect(promise).rejects.toThrow(/unexpected handshake response/)
  })

  it('requires the negotiated capability and a bounded frame limit', async () => {
    const { socket, transport, hellos } = setup()
    const promise = transport.connect()
    socket.open()
    socket.deliver(createDirectFrame('direct.ready', {
      connectionId: hellos()[0]!.connectionId,
      hostDeviceId,
      hostName,
      protocol: DIRECT_PROTOCOL_VERSION,
      capabilities: [],
      maxFrameBytes: 1024 * 1024,
      heartbeatIntervalMs: 25_000,
    }))
    await expect(promise).rejects.toThrow(/unexpected handshake response/)
  })

  it('surfaces a direct.reject error code', async () => {
    const { socket, transport } = setup()
    const promise = transport.connect()
    socket.open()
    socket.deliver(createDirectFrame('direct.reject', { code: 'DIRECT_TRUST_REQUIRED', message: 'This client is not trusted.' }))
    await expect(promise).rejects.toMatchObject({ code: 'DIRECT_TRUST_REQUIRED' })
  })

  it('times out when the Host never answers direct.hello', async () => {
    vi.useFakeTimers()
    const { socket, transport } = setup()
    const promise = transport.connect()
    const rejection = promise.catch(error => error)
    socket.open()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(rejection).resolves.toMatchObject({ code: 'DIRECT_TIMEOUT' })
  })
})

describe('DirectTransport data plane', () => {
  it('relays Noise handshake step 2 and enforces the inbound data counter', async () => {
    const { socket, transport } = await connected()
    const handshake: number[] = []
    const messages: number[][] = []
    transport.onHandshake((step, data) => handshake.push(step, ...data))
    transport.onMessage(data => messages.push([...data]))
    try {
      socket.deliver(createDirectFrame('direct.handshake', {
        connectionId: transport.connectionInfo().connectionId,
        step: 2,
        data: 'AAECAwQ',
      }))
      await flush()
      expect(handshake).toEqual([2, 0, 1, 2, 3, 4])

      socket.deliver(createDirectFrame('direct.data', {
        connectionId: transport.connectionInfo().connectionId,
        counter: 0,
        ciphertext: 'BQYH',
      }))
      await flush()
      expect(messages).toEqual([[5, 6, 7]])

      const closed = vi.fn()
      transport.onClose(closed)
      socket.deliver(createDirectFrame('direct.data', {
        connectionId: transport.connectionInfo().connectionId,
        counter: 2,
        ciphertext: 'BQYH',
      }))
      await flush()
      expect(closed).toHaveBeenCalledTimes(1)
      expect(String(closed.mock.calls[0]![0])).toMatch(/counter/)
    } finally {
      await transport.close()
    }
  })

  it('sends ciphertext with a monotonically increasing counter', async () => {
    const { socket, transport } = await connected()
    try {
      await transport.send(new Uint8Array([1, 2]))
      await transport.send(new Uint8Array([3]))
      const data = socket.frames().filter(frame => frame.type === 'direct.data')
      expect(data.map(frame => (frame.payload as { counter: number }).counter)).toEqual([0, 1])
      expect(transport.getStats().bytesSent).toBe(3)
    } finally {
      await transport.close()
    }
  })

  it('answers direct.ping with a direct.pong and closes after the idle window', async () => {
    vi.useFakeTimers()
    const { socket, transport } = await connected({ heartbeatIntervalMs: 400, idleTimeoutMs: 100 })
    try {
      socket.deliver(createDirectFrame('direct.ping', { nonce: 'n1' }))
      await vi.advanceTimersByTimeAsync(0)
      const pong = socket.frames().find(frame => frame.type === 'direct.pong')
      expect(pong?.payload).toEqual({ nonce: 'n1' })

      const closed = vi.fn()
      transport.onClose(closed)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(closed).toHaveBeenCalledTimes(1)
      expect(String(closed.mock.calls[0]![0])).toMatch(/stopped responding/)
    } finally {
      await transport.close()
      vi.useRealTimers()
    }
  })

  it('fails closed on a malformed frame and reports the close once', async () => {
    const { socket, transport } = await connected()
    const closed = vi.fn()
    transport.onClose(closed)
    socket.deliverRaw('not-json')
    await flush()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(transport.getStats().connected).toBe(false)
    await transport.close()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
