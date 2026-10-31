import { describe, expect, it } from 'vitest'
import {
  detectTailscale,
  directEndpoints,
  isTailnetAddress,
  isTailnetHostname,
  isTailnetIPv4,
  isTailnetIPv6,
  parseDirectEndpoint,
  tailnetInterfaces,
} from '../src/direct-tailscale.js'

describe('Tailscale address classification', () => {
  it.each([
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.63.1.1', false],
    ['100.128.0.1', false],
    ['192.168.1.1', false],
    ['8.8.8.8', false],
    ['fd7a:115c:a1e0::1', false],
  ])('classifies IPv4 %s as tailnet=%s', (address, expected) => {
    expect(isTailnetIPv4(address)).toBe(expected)
  })

  it('recognizes the Tailscale IPv6 ULA and rejects other IPv6', () => {
    expect(isTailnetIPv6('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetIPv6('FD7A:115C:A1E0:0:0:0:0:1')).toBe(true)
    expect(isTailnetIPv6('fd00::1')).toBe(false)
    expect(isTailnetIPv6('2001:db8::1')).toBe(false)
    expect(isTailnetAddress('100.100.1.2')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetAddress('10.0.0.1')).toBe(false)
  })

  it('only accepts MagicDNS names under .ts.net', () => {
    expect(isTailnetHostname('studio.tail1234.ts.net')).toBe(true)
    expect(isTailnetHostname('studio.tail1234.ts.net.')).toBe(true)
    expect(isTailnetHostname('ts.net')).toBe(false)
    expect(isTailnetHostname('evil-ts.net')).toBe(false)
    expect(isTailnetHostname('studio.example.com')).toBe(false)
  })
})

describe('parseDirectEndpoint', () => {
  it.each([
    ['100.100.1.2:47400', '100.100.1.2', 47400, false],
    ['studio.tail1234.ts.net:47400', 'studio.tail1234.ts.net', 47400, false],
    ['ws://100.100.1.2:47400', '100.100.1.2', 47400, false],
    ['wss://studio.tail1234.ts.net', 'studio.tail1234.ts.net', 47400, true],
    ['[fd7a:115c:a1e0::1]:47500', 'fd7a:115c:a1e0::1', 47500, false],
    ['100.100.1.2', '100.100.1.2', 47400, false],
    ['127.0.0.1:47400', '127.0.0.1', 47400, false],
  ])('accepts %s', (input, host, port, secure) => {
    expect(parseDirectEndpoint(input)).toEqual({
      host,
      port,
      secure,
      url: `${secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${port}/direct/v1`,
    })
  })

  it.each([
    [''],
    ['8.8.8.8:47400'],
    ['example.com:47400'],
    ['100.100.1.2:80'],
    ['100.100.1.2:70000'],
    ['http://100.100.1.2:47400'],
    ['ws://100.100.1.2:47400/direct/v1'],
    ['user:pass@100.100.1.2:47400'],
    ['100.100.1.2:47400?token=1'],
    ['100.100.1.2:47400#fragment'],
    ['/100.100.1.2'],
  ])('rejects %s', input => {
    expect(() => parseDirectEndpoint(input)).toThrow()
  })

  it('uses the caller port as the default', () => {
    expect(parseDirectEndpoint('100.100.1.2', 47999).port).toBe(47999)
  })
})

describe('directEndpoints', () => {
  it('lists MagicDNS first, then IPv4 and bracketed IPv6 tailnet addresses', () => {
    expect(directEndpoints('studio.tail1234.ts.net', ['100.100.1.2', 'fd7a:115c:a1e0::1'], 47400)).toEqual([
      'studio.tail1234.ts.net:47400',
      '100.100.1.2:47400',
      '[fd7a:115c:a1e0::1]:47400',
    ])
  })

  it('drops non-tailnet inputs and a bare suffix', () => {
    expect(directEndpoints('ts.net', ['8.8.8.8', '100.100.1.2'], 47400)).toEqual(['100.100.1.2:47400'])
  })
})

describe('tailnetInterfaces', () => {
  it('keeps only tailnet addresses from the interface list', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4' as const }],
      en0: [{ address: '192.168.1.20', family: 'IPv4' as const }],
      tailscale0: [
        { address: '100.100.1.2', family: 'IPv4' as const },
        { address: 'fd7a:115c:a1e0::2', family: 'IPv6' as const },
      ],
    } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    expect(tailnetInterfaces(interfaces)).toEqual([
      { address: '100.100.1.2', family: 'IPv4' },
      { address: 'fd7a:115c:a1e0::2', family: 'IPv6' },
    ])
  })
})

const cliStatus = JSON.stringify({
  BackendState: 'Running',
  Self: {
    HostName: 'studio',
    DNSName: 'studio.tail1234.ts.net.',
    TailscaleIPs: ['100.100.1.2', 'fd7a:115c:a1e0::1'],
  },
  MagicDNSSuffix: 'tail1234.ts.net',
})

describe('detectTailscale', () => {
  it('parses the CLI status output and builds endpoints', async () => {
    const status = await detectTailscale({
      port: 47400,
      execFileImpl: ((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(null, cliStatus)
      }) as unknown as typeof import('node:child_process').execFile,
      networkInterfacesImpl: (() => ({})) as unknown as typeof import('node:os').networkInterfaces,
    })
    expect(status).toMatchObject({
      detected: true,
      source: 'cli',
      backendState: 'Running',
      hostName: 'studio',
      dnsName: 'studio.tail1234.ts.net',
      magicDnsSuffix: 'tail1234.ts.net',
    })
    expect(status.addresses).toEqual([
      { address: '100.100.1.2', family: 'IPv4' },
      { address: 'fd7a:115c:a1e0::1', family: 'IPv6' },
    ])
    expect(status.endpoints).toEqual([
      'studio.tail1234.ts.net:47400',
      '100.100.1.2:47400',
      '[fd7a:115c:a1e0::1]:47400',
    ])
  })

  it('falls back to network interfaces when the CLI is unavailable', async () => {
    const status = await detectTailscale({
      port: 47400,
      execFileImpl: ((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error) => void) => {
        callback(new Error('not installed'))
      }) as unknown as typeof import('node:child_process').execFile,
      networkInterfacesImpl: (() => ({
        tailscale0: [{ address: '100.100.1.9', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.192.0.0', cidr: null }],
      })) as unknown as typeof import('node:os').networkInterfaces,
      hostnameImpl: () => 'studio',
    })
    expect(status).toMatchObject({ detected: true, source: 'interfaces', hostName: 'studio' })
    expect(status.addresses).toEqual([{ address: '100.100.1.9', family: 'IPv4' }])
    expect(status.endpoints).toEqual(['100.100.1.9:47400'])
  })

  it('reports Tailscale as unavailable when neither the CLI nor an interface exists', async () => {
    const status = await detectTailscale({
      port: 47400,
      execFileImpl: ((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error) => void) => {
        callback(new Error('not installed'))
      }) as unknown as typeof import('node:child_process').execFile,
      networkInterfacesImpl: (() => ({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: null }] })) as unknown as typeof import('node:os').networkInterfaces,
    })
    expect(status).toMatchObject({ detected: false, source: 'none' })
    expect(status.error).toBeTruthy()
  })
})
