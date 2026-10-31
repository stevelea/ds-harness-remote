import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { normalizeDirectEndpoint } from '../src/lib/direct-endpoint'

const secureStore = vi.hoisted(() => {
  const keys = new Map<string, string>()
  return {
    keys,
    getItemAsync: vi.fn(async (key: string) => keys.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { keys.set(key, value) }),
    deleteItemAsync: vi.fn(async (key: string) => { keys.delete(key) }),
  }
})

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
  deleteItemAsync: secureStore.deleteItemAsync,
}))
vi.mock('expo-application', () => ({ applicationId: 'io.github.test.dshremote' }))
vi.mock('expo-device', () => ({ modelName: 'Test Phone' }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  randomUUID: () => globalThis.crypto.randomUUID(),
}))

import {
  clearDirectEndpoint,
  loadDirectEndpoint,
  loadDirectEndpoints,
  saveDirectEndpoint,
} from '../src/services/storage'

const ENDPOINTS_KEY = 'dshremote.direct-endpoints.v1'

describe('direct endpoint validation', () => {
  it('normalizes tailnet/private addresses and strips the optional ws scheme', async () => {
    const cases: Array<[name: string, input: string, expected: string]> = [
      ['cgnat', '100.64.0.12:47400', '100.64.0.12:47400'],
      ['cgnat upper bound', '100.127.255.254:47400', '100.127.255.254:47400'],
      ['explicit ws', 'ws://100.64.0.12:47400', '100.64.0.12:47400'],
      ['tailscale ula', '[fd7a:115c:a1e0::1]:47400', '[fd7a:115c:a1e0::1]:47400'],
      ['magicdns wss', 'wss://my-mac.tail1234.ts.net:47400', 'wss://my-mac.tail1234.ts.net:47400'],
      ['case folding', 'My-Mac.Tail1234.TS.NET:47400', 'my-mac.tail1234.ts.net:47400'],
      ['loopback ipv4', '127.0.0.1:47400', '127.0.0.1:47400'],
      ['loopback ipv6', '[::1]:47400', '[::1]:47400'],
      ['port lower bound', '100.64.0.12:1024', '100.64.0.12:1024'],
      ['port upper bound', '100.64.0.12:65535', '100.64.0.12:65535'],
    ]
    await runScenarios(cases.map(([name, input, expected]) => ({ name, run: () => {
      expect(normalizeDirectEndpoint(input)).toBe(expected)
    } })))
  })

  it('rejects public targets, paths, credentials, queries and invalid ports', async () => {
    const cases = [
      '8.8.8.8:47400',
      '100.128.0.1:47400',
      '10.0.0.5:47400',
      '10.0.2.2:47400',
      '172.16.0.1:47400',
      '192.168.1.20:47400',
      '169.254.10.1:47400',
      '[2001:db8::1]:47400',
      '[fd7a:115c:a1e1::1]:47400',
      'example.com:47400',
      'ts.net:47400',
      'my-mac.example.ts.net.attacker.test:47400',
      'my-mac.ts.net',
      'my-mac.ts.net:0',
      'my-mac.ts.net:1023',
      'my-mac.ts.net:65536',
      'my-mac.ts.net:notaport',
      'ws://my-mac.ts.net:47400/direct/v1',
      'my-mac.ts.net:47400/path',
      'my-mac.ts.net:47400?x=1',
      'my-mac.ts.net:47400#fragment',
      'user:pass@my-mac.ts.net:47400',
      'https://my-mac.ts.net:47400',
      'ftp://my-mac.ts.net:47400',
      '',
      '   ',
    ]
    await runScenarios(cases.map(input => ({ name: input, run: () => {
      expect(() => normalizeDirectEndpoint(input)).toThrow()
    } })))
  })
})

describe('saved direct endpoints', () => {
  beforeEach(() => {
    secureStore.keys.clear()
    vi.clearAllMocks()
  })

  it('stores, reads, lists and clears one validated endpoint per host', async () => {
    await saveDirectEndpoint('host-b', '100.64.0.12:47400')
    const normalized = await saveDirectEndpoint('host-a', 'wss://my-mac.tail1234.ts.net:47400')
    expect(normalized).toBe('wss://my-mac.tail1234.ts.net:47400')

    expect(await loadDirectEndpoint('host-b')).toBe('100.64.0.12:47400')
    expect((await loadDirectEndpoints()).map(item => [item.deviceId, item.endpoint])).toEqual([
      ['host-a', 'wss://my-mac.tail1234.ts.net:47400'],
      ['host-b', '100.64.0.12:47400'],
    ])

    await clearDirectEndpoint('host-b')
    expect(await loadDirectEndpoint('host-b')).toBeUndefined()
    expect((await loadDirectEndpoints()).map(item => item.deviceId)).toEqual(['host-a'])
    // Clearing the last entry removes the encrypted record entirely.
    await clearDirectEndpoint('host-a')
    expect(secureStore.keys.has(ENDPOINTS_KEY)).toBe(false)

    // Invalid input never overwrites an existing saved address.
    await saveDirectEndpoint('host-a', 'my-mac.tail1234.ts.net:47400')
    await expect(saveDirectEndpoint('host-a', '8.8.8.8:47400')).rejects.toThrow()
    expect(await loadDirectEndpoint('host-a')).toBe('my-mac.tail1234.ts.net:47400')

    // A tampered or legacy record is ignored instead of being handed to the transport.
    secureStore.keys.set(ENDPOINTS_KEY, JSON.stringify({
      byDevice: {
        'host-bad': { endpoint: 'https://public.example.com:443', updatedAt: 1 },
        'host-ok': { endpoint: '100.64.0.12:47400', updatedAt: 2 },
      },
    }))
    expect((await loadDirectEndpoints()).map(item => [item.deviceId, item.endpoint])).toEqual([
      ['host-ok', '100.64.0.12:47400'],
    ])
  })

  it('keeps concurrent saves for different hosts', async () => {
    await Promise.all([
      saveDirectEndpoint('host-a', '100.64.0.12:47400'),
      saveDirectEndpoint('host-b', '100.64.0.13:47400'),
      saveDirectEndpoint('host-c', '100.64.0.14:47400'),
    ])
    expect((await loadDirectEndpoints()).map(item => item.deviceId)).toEqual(['host-a', 'host-b', 'host-c'])
  })
})
