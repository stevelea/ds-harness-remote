import { strings as zhCN } from '../locales/i18n'

/** Tailscale IPv4 addresses come from the RFC 6598 CGNAT range. */
const TAILSCALE_IPV4_FIRST_OCTET = 100
const TAILSCALE_IPV4_SECOND_MIN = 64
const TAILSCALE_IPV4_SECOND_MAX = 127
/** Tailscale unique-local IPv6 prefix assigned to a tailnet. */
const TAILSCALE_ULA_PREFIX = 'fd7a:115c:a1e0:'
/** Tailscale MagicDNS tailnet hostnames, e.g. `my-mac.tail1234.ts.net`. */
const TAILSCALE_HOSTNAME_SUFFIX = '.ts.net'
/** The Host listener rejects privileged/unconfigured ports, matching the plugin parser. */
const MIN_DIRECT_PORT = 1024
const MAX_DIRECT_PORT = 65_535
const MAX_HOSTNAME_LENGTH = 253
const FORBIDDEN_CHARACTERS = /[\s/?#@\\]/u
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//iu
const HOST_PORT = /^([^:]+):(\d{1,5})$/u
const BRACKETED_IPV6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/iu
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

/**
 * Validates a user-entered Direct (Tailscale) address against the addresses a
 * Direct Host listener can actually bind (see the Host plugin's
 * `parseDirectEndpoint`): Tailscale CGNAT IPv4 (`100.64.0.0/10`), the Tailscale
 * ULA prefix (`fd7a:115c:a1e0::/48`), MagicDNS `*.ts.net` names, and loopback
 * for local testing. Public, RFC1918 and link-local targets are rejected, so a
 * typo can never point the serverless path at a non-tailnet service.
 *
 * Input is `host:port`, optionally prefixed with `ws://` or `wss://`.
 * Credentials, query strings, paths, and fragments are rejected; the port must
 * be an explicit 1024–65535 value (the Host's configured Direct port).
 *
 * @returns a normalized endpoint: `host:port`, or `wss://host:port` when the
 * caller explicitly asked for TLS. The `/direct/v1` WebSocket path is added by
 * `DirectTransport.endpointUrl` at connect time.
 */
export function normalizeDirectEndpoint(input: string): string {
  const value = input.trim()
  if (value.length === 0) throw new Error(zhCN.validation.directRequired)

  let scheme = ''
  let target = value
  const schemeMatch = SCHEME_PREFIX.exec(value)
  if (schemeMatch !== null) {
    const protocol = schemeMatch[1]!.toLowerCase()
    if (protocol !== 'ws' && protocol !== 'wss') throw new Error(zhCN.validation.directTarget)
    scheme = protocol
    target = value.slice(schemeMatch[0].length)
  }
  // Reject credentials, query strings, paths, fragments and whitespace on the
  // address itself (the scheme separator was already consumed above).
  if (target.length === 0 || FORBIDDEN_CHARACTERS.test(target)) throw new Error(zhCN.validation.directPartsForbidden)

  const ipv6 = BRACKETED_IPV6.exec(target)
  if (ipv6 !== null) {
    const address = canonicalIpv6(ipv6[1]!)
    if (address === undefined) throw new Error(zhCN.validation.directInvalid)
    if (address !== '::1' && !address.startsWith(TAILSCALE_ULA_PREFIX)) throw new Error(zhCN.validation.directTarget)
    const port = directPort(ipv6[2]!)
    const host = `[${address}]`
    return scheme === 'wss' ? `wss://${host}:${port}` : `${host}:${port}`
  }

  const hostPort = HOST_PORT.exec(target)
  if (hostPort === null) throw new Error(zhCN.validation.directInvalid)
  const host = hostPort[1]!.toLowerCase()
  const port = directPort(hostPort[2]!)
  if (!isDirectHost(host)) throw new Error(zhCN.validation.directTarget)
  return scheme === 'wss' ? `wss://${host}:${port}` : `${host}:${port}`
}

/** True when the stored value is still an acceptable Direct address. */
export function isDirectEndpoint(input: unknown): input is string {
  if (typeof input !== 'string') return false
  try {
    normalizeDirectEndpoint(input)
    return true
  } catch {
    return false
  }
}

function directPort(value: string): number {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < MIN_DIRECT_PORT || port > MAX_DIRECT_PORT) {
    throw new Error(zhCN.validation.directInvalid)
  }
  return port
}

function isDirectHost(host: string): boolean {
  return isTailscaleIPv4(host) || isLoopbackHost(host) || isTailscaleHostname(host)
}

function isTailscaleIPv4(host: string): boolean {
  const match = IPV4.exec(host)
  if (match === null) return false
  const octets = match.slice(1).map(octet => Number(octet))
  if (octets.some(octet => octet > 255)) return false
  return octets[0] === TAILSCALE_IPV4_FIRST_OCTET
    && octets[1]! >= TAILSCALE_IPV4_SECOND_MIN
    && octets[1]! <= TAILSCALE_IPV4_SECOND_MAX
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1'
}

function isTailscaleHostname(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false
  if (!host.endsWith(TAILSCALE_HOSTNAME_SUFFIX)) return false
  const labels = host.split('.')
  // `x.ts.net` needs at least one machine label in front of the MagicDNS suffix.
  if (labels.length < 3) return false
  return labels.every(label => DNS_LABEL.test(label))
}

/** Canonical lowercase IPv6 form; undefined when the address is malformed. */
function canonicalIpv6(address: string): string | undefined {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  } catch {
    return undefined
  }
}
