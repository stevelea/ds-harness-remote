import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRpcResponse, type RemoteMessage } from '@dsh-remote/protocol'
import { ClientConnection } from '../src/client-connection.js'
import { ConnectionController } from '../src/connection-controller.js'
import { DirectHostListener } from '../src/direct-host-listener.js'
import { IdentityStore, type HostIdentity, type TrustedPeer } from '../src/identity-store.js'
import { SafeLogger } from '../src/logging.js'
import { resolveConfig } from '../src/config.js'
import type { RpcRouter } from '../src/rpc-router.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const quietLogger = new SafeLogger({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })

async function temporaryIdentity(name: string): Promise<{ store: IdentityStore; identity: HostIdentity }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-e2e-'))
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
    membershipId: 'membership-direct-e2e',
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Full runtime path: ClientConnection.connectDirect -> DirectTransport ->
 * DirectHostListener -> ConnectionController -> RpcRouter. This is the
 * integration the unit tests on each side cannot prove on their own.
 */
describe('Direct runtime end to end', () => {
  it('connects a client runtime to a Host controller and exchanges RPCs', async () => {
    const host = await temporaryIdentity('studio-host')
    const client = await temporaryIdentity('phone')
    await host.store.trustPeer({
      deviceId: client.identity.deviceId,
      name: 'phone',
      platform: 'ios',
      publicKey: client.identity.publicKey,
      membershipId: 'membership-direct-e2e',
    })
    const port = await freePort()
    const calls: string[] = []
    const controller = new ConnectionController(host.store, (() => ({
      handle: async (message: RemoteMessage) => {
        const payload = message.payload as { requestId?: string; method?: string }
        calls.push(payload.method ?? 'unknown')
        return createRpcResponse(payload.requestId ?? message.id, { capabilities: ['harness.remote.v1'] })
      },
      closePeerStreams: async () => undefined,
    }) as unknown as RpcRouter), quietLogger)
    cleanup.push(() => controller.close())
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
      accept: channel => controller.accept(channel),
      closeConnection: (connectionId, code) => {
        void controller.closeConnection(connectionId, code, { closedBy: 'host', retryable: true })
      },
    })
    cleanup.push(() => listener.stop())
    await listener.start()

    const connection = new ClientConnection({
      connectionProgressRun: 0,
      connectionProgress: undefined,
      requireIdentity: () => client.identity,
      server: undefined,
      config: resolveConfig({}),
      rtcFactoryProvider: async () => undefined,
      logger: quietLogger,
      identities: client.store,
    } as unknown as ConstructorParameters<typeof ClientConnection>[0])
    const remote = await connection.connectDirect(trustedHost(host.identity), `127.0.0.1:${port}`)
    cleanup.push(() => remote.client.close())
    expect(remote.direct).toBe(true)
    expect(remote.transport.getStats()).toMatchObject({ mode: 'Direct', connected: true })
    expect(remote.features.remoteGateway).toBe(true)
    expect(calls).toContain('harness.transport.describe')
    expect(controller.connectedPeers()).toEqual([{ deviceId: client.identity.deviceId, mode: 'Direct' }])

    // A second RPC proves the channel stays usable after capability discovery.
    const described = await remote.client.rpc('harness.transport.describe', {})
    expect(described).toMatchObject({ capabilities: ['harness.remote.v1'] })
    expect(listener.status()).toMatchObject({ running: true, activeConnections: 1 })

    await remote.client.close()
    await waitFor(() => controller.connectionCount() === 0)
    await waitFor(() => listener.status().activeConnections === 0)
  })

  it('refuses a client the Host never authorized', async () => {
    const host = await temporaryIdentity('studio-host')
    const client = await temporaryIdentity('phone')
    const port = await freePort()
    const accepted = vi.fn()
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
      accept: accepted,
    })
    cleanup.push(() => listener.stop())
    await listener.start()
    const connection = new ClientConnection({
      connectionProgressRun: 0,
      connectionProgress: undefined,
      requireIdentity: () => client.identity,
      server: undefined,
      config: resolveConfig({}),
      rtcFactoryProvider: async () => undefined,
      logger: quietLogger,
      identities: client.store,
    } as unknown as ConstructorParameters<typeof ClientConnection>[0])
    // The Host never trusted this Client: the channel is rejected before Noise and
    // never reaches the Host connection controller.
    await expect(connection.connectDirect(trustedHost(host.identity), `127.0.0.1:${port}`)).rejects.toMatchObject({ code: 'DIRECT_TRUST_REQUIRED' })
    expect(accepted).not.toHaveBeenCalled()
  })
})
