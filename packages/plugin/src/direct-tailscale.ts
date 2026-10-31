import { execFile } from 'node:child_process'
import { hostname as systemHostname, networkInterfaces as systemNetworkInterfaces } from 'node:os'
import { DEFAULT_DIRECT_PORT } from './config.js'

/**
 * Tailscale detection and Direct endpoint parsing.
 *
 * The Direct transport is serverless and therefore only reachable over the
 * private tailnet: the Host binds exactly the Tailscale addresses it owns and a
 * Client is only allowed to dial a tailnet address or a MagicDNS `*.ts.net`
 * name. Public addresses never pass validation, so a typo cannot turn the
 * opt-in listener into a public service.
 */

export interface TailnetAddress {
  address: string
  family: 'IPv4' | 'IPv6'
}

export interface TailscaleStatus {
  detected: boolean
  backendState?: string
  hostName?: string
  /** MagicDNS name without the trailing dot, when the CLI reports one. */
  dnsName?: string
  magicDnsSuffix?: string
  addresses: TailnetAddress[]
  /** Ready-to-display `host:port` endpoints derived from the detected names/addresses. */
  endpoints: string[]
  source: 'cli' | 'interfaces' | 'none'
  error?: string
}

export interface DirectEndpoint {
  host: string
  port: number
  /** Present when the user typed an explicit ws:// or wss:// scheme. */
  secure: boolean
  /** WebSocket URL including the Direct path. */
  url: string
}

export interface DetectTailscaleOptions {
  port?: number
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  execFileImpl?: typeof execFile
  networkInterfacesImpl?: typeof systemNetworkInterfaces
  hostnameImpl?: () => string
}

interface TailscaleCliSelf {
  HostName?: unknown
  DNSName?: unknown
  TailscaleIPs?: unknown
  Online?: unknown
}

interface TailscaleCliStatus {
  BackendState?: unknown
  Self?: TailscaleCliSelf
  MagicDNSSuffix?: unknown
}

const CLI_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
] as const

const MAX_CLI_OUTPUT_BYTES = 512 * 1024

/** RFC 6598 CGNAT shared address space used by Tailscale IPv4 addresses. */
export function isTailnetIPv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  if (octets.some(octet => octet > 255)) return false
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
}

/** Tailscale assigns IPv6 addresses from the fd7a:115c:a1e0::/48 ULA. */
export function isTailnetIPv6(value: string): boolean {
  return value.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export function isTailnetAddress(value: string): boolean {
  return isTailnetIPv4(value) || isTailnetIPv6(value)
}

/** MagicDNS names always end in `.ts.net`. */
export function isTailnetHostname(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return host.endsWith('.ts.net') && host.length > '.ts.net'.length
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/** The Host may only bind a tailnet address; loopback is used by local tests. */
export function isBindableDirectAddress(value: string): boolean {
  return isTailnetAddress(value) || isLoopbackHost(value)
}

function formatHostForEndpoint(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

/** Display endpoints for a Host: MagicDNS first, then the tailnet IPs. */
export function directEndpoints(dnsName: string | undefined, addresses: readonly string[], port = DEFAULT_DIRECT_PORT): string[] {
  const endpoints = new Set<string>()
  const name = dnsName?.trim().replace(/\.$/, '')
  if (name !== undefined && isTailnetHostname(name)) endpoints.add(`${name}:${port}`)
  for (const address of addresses) {
    if (isTailnetAddress(address)) endpoints.add(`${formatHostForEndpoint(address)}:${port}`)
  }
  return [...endpoints]
}

/**
 * Parse a user-entered Direct address.
 *
 * Accepts `host:port`, `ws://host:port`, `wss://host:port` and a MagicDNS name
 * with an optional port. Only tailnet addresses, `*.ts.net` names and loopback
 * pass validation; the port defaults to `defaultPort`.
 */
export function parseDirectEndpoint(input: string, defaultPort = DEFAULT_DIRECT_PORT): DirectEndpoint {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new TypeError('A Direct host address is required.')
  if (trimmed.length > 512) throw new TypeError('A Direct host address is too long.')
  let secure = false
  let value = trimmed
  if (/^wss:\/\//i.test(value)) { secure = true; value = value.replace(/^wss:\/\//i, '') }
  else if (/^ws:\/\//i.test(value)) { value = value.replace(/^ws:\/\//i, '') }
  else if (/^https?:\/\//i.test(value)) throw new TypeError('Use a ws://, wss:// or host:port Direct address, not an HTTP URL.')
  if (value.startsWith('/')) throw new TypeError('A Direct host address must not include a path.')
  if (/[?#@/]/.test(value)) throw new TypeError('A Direct host address must not include credentials, a path, query parameters or a fragment.')

  let host: string
  let port = defaultPort
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value)
    if (match === null) throw new TypeError('A bracketed IPv6 Direct address must look like [fd7a:...]:port.')
    host = match[1]!
    if (match[2] !== undefined) port = parsePort(match[2])
  } else {
    const colonCount = [...value].filter(char => char === ':').length
    if (colonCount > 1) {
      // Bare IPv6 address without a port.
      host = value
    } else if (colonCount === 1) {
      const [name, portText] = value.split(':') as [string, string]
      host = name
      port = parsePort(portText)
    } else {
      host = value
    }
  }

  if (host.length === 0) throw new TypeError('A Direct host address is required.')
  if (!isTailnetAddress(host) && !isTailnetHostname(host) && !isLoopbackHost(host)) {
    throw new TypeError('Direct mode expects a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a *.ts.net name.')
  }
  if (isTailnetHostname(host) && secure === false) secure = false
  const urlHost = host.includes(':') ? `[${host}]` : host
  return {
    host,
    port,
    secure,
    url: `${secure ? 'wss' : 'ws'}://${urlHost}:${port}/direct/v1`,
  }
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new TypeError('The Direct port is invalid.')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError('The Direct port must be between 1024 and 65535.')
  return port
}

/**
 * Detect Tailscale from the CLI LocalAPI (`tailscale status --json`) and fall
 * back to scanning network interfaces for tailnet ranges. Never throws: the
 * caller reports `detected: false` and the listener stays off.
 */
export async function detectTailscale(options: DetectTailscaleOptions = {}): Promise<TailscaleStatus> {
  const port = options.port ?? DEFAULT_DIRECT_PORT
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 2_000
  try {
    const cli = await readTailscaleCli({ env, timeoutMs, execFileImpl: options.execFileImpl })
    if (cli !== undefined) {
      const addresses = normalizeAddresses(cli.addresses)
      const dnsName = normalizeDnsName(cli.dnsName)
      if (addresses.length > 0) {
        return {
          detected: true,
          backendState: cli.backendState,
          hostName: cli.hostName,
          ...(dnsName === undefined ? {} : { dnsName }),
          ...(cli.magicDnsSuffix === undefined ? {} : { magicDnsSuffix: cli.magicDnsSuffix }),
          addresses,
          endpoints: directEndpoints(dnsName, addresses.map(address => address.address), port),
          source: 'cli',
        }
      }
      if (cli.backendState !== undefined && cli.backendState !== 'Running' && cli.backendState !== 'Starting') {
        return notDetected(`Tailscale is ${cli.backendState}.`, 'cli')
      }
    }
  } catch {
    // Fall through to the interface scan; CLI failures are not user-facing errors.
  }
  const scan = options.networkInterfacesImpl ?? systemNetworkInterfaces
  const addresses = tailnetInterfaces(scan())
  if (addresses.length > 0) {
    const hostName = (options.hostnameImpl ?? systemHostname)()
    return {
      detected: true,
      hostName,
      addresses,
      endpoints: directEndpoints(undefined, addresses.map(address => address.address), port),
      source: 'interfaces',
    }
  }
  return notDetected('No Tailscale interface was detected on this machine.', 'none')
}

export function tailnetInterfaces(interfaces: ReturnType<typeof systemNetworkInterfaces>): TailnetAddress[] {
  const result: TailnetAddress[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const rawFamily = String(entry.family)
      const family = rawFamily === 'IPv4' || rawFamily === '4' ? 'IPv4' as const : rawFamily === 'IPv6' || rawFamily === '6' ? 'IPv6' as const : undefined
      if (family === undefined) continue
      if (!isTailnetAddress(entry.address)) continue
      result.push({ address: entry.address.replace(/%.*$/, ''), family })
    }
  }
  return dedupeAddresses(result)
}

function notDetected(error: string, source: TailscaleStatus['source']): TailscaleStatus {
  return { detected: false, addresses: [], endpoints: [], source, error }
}

interface CliResult {
  backendState?: string
  hostName?: string
  dnsName?: string
  magicDnsSuffix?: string
  addresses: string[]
}

async function readTailscaleCli(input: {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  execFileImpl?: typeof execFile
}): Promise<CliResult | undefined> {
  const run = input.execFileImpl ?? execFile
  const candidates = [input.env.DSH_TAILSCALE_BIN, ...CLI_CANDIDATES].filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        run(candidate, ['status', '--json'], { timeout: input.timeoutMs, maxBuffer: MAX_CLI_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
          if (error !== null) reject(error)
          else resolve(String(stdout))
        })
      })
      const parsed = JSON.parse(output) as TailscaleCliStatus
      if (parsed.BackendState !== 'Running' && parsed.BackendState !== 'Starting' && parsed.BackendState !== 'Stopped') return undefined
      const self = parsed.Self
      const addresses = Array.isArray(self?.TailscaleIPs)
        ? self.TailscaleIPs.filter((value): value is string => typeof value === 'string')
        : []
      return {
        ...(typeof parsed.BackendState === 'string' ? { backendState: parsed.BackendState } : {}),
        ...(typeof self?.HostName === 'string' ? { hostName: self.HostName } : {}),
        ...(typeof self?.DNSName === 'string' ? { dnsName: self.DNSName } : {}),
        ...(typeof parsed.MagicDNSSuffix === 'string' ? { magicDnsSuffix: parsed.MagicDNSSuffix } : {}),
        addresses,
      }
    } catch {
      // Try the next known CLI location.
    }
  }
  return undefined
}

function normalizeAddresses(values: readonly string[]): TailnetAddress[] {
  return dedupeAddresses(values
    .map(value => value.replace(/%.*$/, ''))
    .filter(isTailnetAddress)
    .map(address => ({ address, family: isTailnetIPv4(address) ? 'IPv4' as const : 'IPv6' as const })))
}

function normalizeDnsName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = value.trim().replace(/\.$/, '')
  return isTailnetHostname(name) ? name : undefined
}

function dedupeAddresses(addresses: TailnetAddress[]): TailnetAddress[] {
  const seen = new Set<string>()
  return addresses.filter(item => {
    if (seen.has(item.address)) return false
    seen.add(item.address)
    return true
  })
}
