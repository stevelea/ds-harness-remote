import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ClientSecureTransport } from '../src/client-secure-transport.js'
import { DirectHostListener } from '../src/direct-host-listener.js'
import { IdentityStore, type HostIdentity, type TrustedPeer } from '../src/identity-store.js'
import { SafeLogger } from '../src/logging.js'
import { DirectTransport } from '@dsh-remote/webrtc'
import { createMessage, decodeMessage, encodeMessage, type RemoteMessage } from '@dsh-remote/protocol'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const quietLogger = new SafeLogger({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })

async function temporaryIdentity(name: string): Promise<{ store: IdentityStore; identity: HostIdentity }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new IdentityStore({ directory })
  const identity = await store.loadOrCreate(name)
  return { store, identity }
}

function trustedHost(identity: HostIdentity): TrustedPeer {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: 'darwin',
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    trustedAt: Date.now(),
    membershipId: 'membership-direct-test',
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

interface Harness {
  host: { store: IdentityStore; identity: HostIdentity }
  listener: DirectHostListener
  port: number
  accepted: Array<{ messages: RemoteMessage[]; peerDeviceId: string; mode?: string; memberships: string[]; send: (message: RemoteMessage) => Promise<void> }>
}

async function startHost(): Promise<Harness> {
  const host = await temporaryIdentity('studio-host')
  const port = await freePort()
  const accepted: Harness['accepted'] = []
  const listener = new DirectHostListener({
    identity: host.identity,
    identities: host.store,
    logger: quietLogger,
    port,
    detect: async () => ({
      detected: true,
      source: 'cli',
      addresses: [{ address: '127.0.0.1', family: 'IPv4' }],
      endpoints: [`127.0.0.1:${port}`],
    }),
    bindAddresses: ['127.0.0.1'],
    accept: async channel => {
      const entry = {
        messages: [] as RemoteMessage[],
        peerDeviceId: channel.peerDeviceId,
        mode: channel.mode,
        memberships: [channel.security.membershipId],
        send: (message: RemoteMessage) => channel.send(message),
      }
      channel.onMessage(message => entry.messages.push(message))
      accepted.push(entry)
    },
  })
  cleanup.push(() => listener.stop())
  await listener.start()
  return { host, listener, port, accepted }
}

async function trustClient(harness: Harness, client: { store: IdentityStore; identity: HostIdentity }): Promise<void> {
  await harness.host.store.trustPeer({
    deviceId: client.identity.deviceId,
    name: 'phone',
    platform: 'ios',
    publicKey: client.identity.publicKey,
    membershipId: 'membership-direct-test',
  })
}

function clientSecure(port: number, client: { store: IdentityStore; identity: HostIdentity }, host: HostIdentity): {
  secure: ClientSecureTransport
  transport: DirectTransport
} {
  const transport = new DirectTransport(DirectTransport.endpointUrl(`127.0.0.1:${port}`), {
    deviceId: client.identity.deviceId,
    hostDeviceId: host.deviceId,
  })
  const secure = new ClientSecureTransport(transport, client.identity, trustedHost(host))
  return { secure, transport }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('DirectHostListener', () => {
  it('accepts a trusted client, runs Noise IK and carries encrypted messages both ways', async () => {
    const harness = await startHost()
    const client = await temporaryIdentity('phone')
    await trustClient(harness, client)

    const { secure } = clientSecure(harness.port, client, harness.host.identity)
    cleanup.push(() => secure.close())
    await secure.connect()
    await waitFor(() => harness.accepted.length === 1)
    const accepted = harness.accepted[0]!
    expect(accepted.peerDeviceId).toBe(client.identity.deviceId)
    expect(accepted.mode).toBe('Direct')
    expect(accepted.memberships).toEqual([`direct:${client.identity.deviceId}`])

    const outbound = createMessage('event', { name: 'harness.event', data: { ok: true } })
    await secure.send(encodeMessage(outbound))
    await waitFor(() => accepted.messages.length === 1)
    expect(accepted.messages[0]).toMatchObject({ type: outbound.type, payload: outbound.payload })

    const inbound = createMessage('rpc.response', { requestId: 'r1', result: { ok: true } })
    const received: RemoteMessage[] = []
    secure.onMessage(data => received.push(decodeMessage(data)))
    await accepted.send(inbound)
    await waitFor(() => received.length === 1)
    expect(received[0]).toMatchObject({ type: 'rpc.response', payload: { requestId: 'r1' } })

    expect(harness.listener.status().activeConnections).toBe(1)
  })

  it('rejects a client that the Host never authorized, before Noise starts', async () => {
    const harness = await startHost()
    const client = await temporaryIdentity('unknown-phone')

    const { secure } = clientSecure(harness.port, client, harness.host.identity)
    await expect(secure.connect()).rejects.toMatchObject({ code: 'DIRECT_TRUST_REQUIRED' })
    expect(harness.accepted).toHaveLength(0)
    expect(harness.listener.status().pendingHandshakes).toBe(0)
  })

  it('fails closed when the client pinned a different Host identity key', async () => {
    const harness = await startHost()
    const client = await temporaryIdentity('phone')
    await trustClient(harness, client)
    const impostorHost = await temporaryIdentity('impostor-host')

    const transport = new DirectTransport(DirectTransport.endpointUrl(`127.0.0.1:${harness.port}`), {
      deviceId: client.identity.deviceId,
      hostDeviceId: harness.host.identity.deviceId,
    })
    // The address/device id match the real Host, but the pinned identity key does not:
    // Noise IK must reject the transcript even though direct.ready looked valid.
    const secure = new ClientSecureTransport(transport, client.identity, {
      ...trustedHost(harness.host.identity),
      publicKey: impostorHost.identity.publicKey,
    })
    await expect(secure.connect()).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(harness.accepted).toHaveLength(0)
  })

  it('closes a socket that sends a malformed Direct frame', async () => {
    const harness = await startHost()
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/direct/v1`)
    cleanup.push(() => socket.close())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    socket.send('not-a-direct-frame')
    await expect(closed).resolves.toEqual({ code: 1008, reason: 'DIRECT_INVALID_FRAME' })
    await waitFor(() => harness.listener.status().pendingHandshakes === 0)
  })

  it('stays off when Tailscale is not detected', async () => {
    const host = await temporaryIdentity('host')
    const port = await freePort()
    const listener = new DirectHostListener({
      identity: host.identity,
      identities: host.store,
      logger: quietLogger,
      port,
      detect: async () => ({ detected: false, source: 'none', addresses: [], endpoints: [], error: 'TAILSCALE_NOT_DETECTED' }),
      accept: async () => undefined,
    })
    cleanup.push(() => listener.stop())
    await listener.start()
    const status = listener.status()
    expect(status.running).toBe(false)
    expect(status.error).toBe('TAILSCALE_NOT_DETECTED')
    expect(status.endpoints).toEqual([])
  })
})
