import { describe, expect, it } from 'vitest'
import {
  DIRECT_CAPABILITY,
  DIRECT_PROTOCOL_VERSION,
  MAX_DIRECT_FRAME_BYTES,
  createDirectFrame,
  decodeDirectFrame,
  encodeDirectFrame,
  parseDirectFrame,
  type DirectClosePayload,
  type DirectDataPayload,
  type DirectHandshakePayload,
  type DirectHelloPayload,
  type DirectPingPayload,
  type DirectReadyPayload,
  type DirectRejectPayload,
} from '../src/index.js'

const connectionId = '01942c3e-0a51-7000-8000-000000000001'
const clientDeviceId = '01942c3e-0a51-7000-8000-000000000002'
const hostDeviceId = '01942c3e-0a51-7000-8000-000000000003'

const validPayloads: Record<string, unknown> = {
  'direct.hello': {
    connectionId,
    clientDeviceId,
    clientVersion: '0.6.0',
    capabilities: [DIRECT_CAPABILITY],
  } satisfies DirectHelloPayload,
  'direct.ready': {
    connectionId,
    hostDeviceId,
    hostName: 'studio.tail1234.ts.net',
    hostPlatform: 'darwin',
    protocol: DIRECT_PROTOCOL_VERSION,
    capabilities: [DIRECT_CAPABILITY],
    maxFrameBytes: MAX_DIRECT_FRAME_BYTES,
    heartbeatIntervalMs: 25_000,
  } satisfies DirectReadyPayload,
  'direct.reject': { code: 'DIRECT_TRUST_REQUIRED', message: 'This client is not trusted locally.' } satisfies DirectRejectPayload,
  'direct.handshake': { connectionId, step: 1, data: 'AAECAwQ' } satisfies DirectHandshakePayload,
  'direct.data': { connectionId, counter: 0, ciphertext: 'AAECAwQ' } satisfies DirectDataPayload,
  'direct.ping': { nonce: 'abcd' } satisfies DirectPingPayload,
  'direct.pong': { nonce: 'abcd' } satisfies DirectPingPayload,
  'direct.close': { code: 'DIRECT_CLOSED', message: 'Closed by the client.' } satisfies DirectClosePayload,
}

function frame(type: string, payload: unknown): unknown {
  return { v: DIRECT_PROTOCOL_VERSION, id: `frame-${type}`, type, timestamp: Date.now(), payload }
}

describe('Direct transport frames', () => {
  it.each(Object.entries(validPayloads))('round-trips %s through the canonical encoder', (type, payload) => {
    const encoded = encodeDirectFrame(createDirectFrame(type as never, payload))
    const decoded = decodeDirectFrame(encoded)
    expect(decoded.type).toBe(type)
    expect(decoded.payload).toEqual(payload)
    expect(JSON.parse(encoded)).toMatchObject({ v: DIRECT_PROTOCOL_VERSION, type })
  })

  it('accepts a Uint8Array received from a binary socket', () => {
    const encoded = encodeDirectFrame(createDirectFrame('direct.ping', { nonce: 'abcd' }))
    expect(decodeDirectFrame(new TextEncoder().encode(encoded)).payload).toEqual({ nonce: 'abcd' })
  })

  it.each([
    ['missing payload', { v: DIRECT_PROTOCOL_VERSION, id: 'x', type: 'direct.ping', timestamp: Date.now() }],
    ['unknown type', frame('direct.unknown', {})],
    ['wrong version', frame('direct.ping', { nonce: 'abcd' })],
    ['extra envelope field', { ...(frame('direct.ping', {}) as object), extra: true }],
  ])('rejects an invalid envelope (%s)', (_label, value) => {
    if (_label === 'wrong version') (value as { v: number }).v = 2
    expect(() => parseDirectFrame(value)).toThrow()
  })

  it.each([
    ['hello rejects an empty capability list with duplicates', 'direct.hello', { ...validPayloads['direct.hello'], capabilities: ['a', 'a'] }],
    ['hello rejects a non-uuid connection id', 'direct.hello', { ...validPayloads['direct.hello'], connectionId: 'conn-1' }],
    ['hello rejects extra fields', 'direct.hello', { ...validPayloads['direct.hello'], extra: true }],
    ['ready rejects duplicate capabilities', 'direct.ready', { ...validPayloads['direct.ready'], capabilities: ['a', 'a'] }],
    ['ready rejects a non-positive heartbeat interval', 'direct.ready', { ...validPayloads['direct.ready'], heartbeatIntervalMs: 0 }],
    ['ready rejects a negative frame limit', 'direct.ready', { ...validPayloads['direct.ready'], maxFrameBytes: -1 }],
    ['handshake rejects step 3', 'direct.handshake', { ...validPayloads['direct.handshake'], step: 3 }],
    ['handshake rejects padded base64', 'direct.handshake', { ...validPayloads['direct.handshake'], data: 'AAECAwQ=' }],
    ['data rejects a negative counter', 'direct.data', { ...validPayloads['direct.data'], counter: -1 }],
    ['data rejects a fractional counter', 'direct.data', { ...validPayloads['direct.data'], counter: 1.5 }],
    ['close rejects an empty code', 'direct.close', { ...validPayloads['direct.close'], code: '' }],
    ['reject rejects an empty message', 'direct.reject', { ...validPayloads['direct.reject'], message: '' }],
  ])('%s', (_label, type, payload) => {
    expect(() => parseDirectFrame(frame(type, payload))).toThrow()
  })

  it('rejects frames above the Direct frame limit and honours a lower caller limit', () => {
    const frameWithLargeCiphertext = createDirectFrame('direct.data', {
      connectionId,
      counter: 0,
      ciphertext: 'A'.repeat(600_000),
    } satisfies DirectDataPayload)
    expect(() => encodeDirectFrame(frameWithLargeCiphertext, 1024)).toThrow(/Direct frame exceeds/)
    expect(() => decodeDirectFrame(encodeDirectFrame(frameWithLargeCiphertext), 1024)).toThrow(/Direct frame exceeds/)
  })

  it('rejects duplicate JSON keys and invalid JSON without echoing frame content', () => {
    const encoded = encodeDirectFrame(createDirectFrame('direct.ping', {}))
    const duplicated = encoded.replace('"id":"', '"id":"dup","id":"')
    expect(() => decodeDirectFrame(duplicated)).toThrow(/Invalid Direct transport frame/)
    expect(() => decodeDirectFrame('not json')).toThrow(/Invalid Direct transport frame/)
  })

  it('keeps envelope metadata separate from payload schemas', () => {
    const parsed = parseDirectFrame(frame('direct.ready', validPayloads['direct.ready']))
    expect(parsed.v).toBe(DIRECT_PROTOCOL_VERSION)
    expect(parsed.payload).toMatchObject({ hostPlatform: 'darwin' })
  })
})
