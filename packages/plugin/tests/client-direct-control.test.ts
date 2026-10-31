import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@dsh-remote/crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import type { ControlResult } from '../src/control-result.js'
import { ClientModeRuntime } from '../src/client-runtime.js'
import type { ResolvedConfig } from '../src/config.js'
import { IdentityStore, type TrustedPeer } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import type { ClientServerApi } from '../src/server-api.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function config(): ResolvedConfig {
  return {
    terminal: { enabled: false },
    loopback: { ports: [] },
    direct: { enabled: false, port: 47400 },
    enabled: true,
    role: 'both',
    serverUrl: 'https://dsh.r2049.cn',
    deviceName: 'Local Harness',
    forceRelay: false,
    rotatePinnedPeerKey: false,
    logLevel: 'error',
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 },
    codex: { enabled: false, binary: 'codex' },
    cursor: { enabled: false, binary: 'agent' },
  }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

function gatewayWithCarrier() {
  const open = vi.fn(async () => (async function* () {})())
  return {
    invoke: vi.fn(async () => undefined),
    stream: vi.fn(async () => (async function* () {})()),
    dispatchRpc: vi.fn(async () => ({ ok: true as const })),
    openWireStream: open,
    wireStream: { open, failure: () => ({ code: 'internal', message: 'failed', details: {} }) },
  }
}

function remoteCode(result: ControlResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.details?.remoteCode as string | undefined
}

async function fixture(): Promise<{
  runtime: ClientModeRuntime
  identities: IdentityStore
  peer: TrustedPeer
  control: (endpoint: string, payload?: unknown) => Promise<ControlResult<unknown>>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-control-'))
  directories.push(directory)
  const identities = new IdentityStore({ directory })
  const runtime = new ClientModeRuntime(
    config(),
    identities,
    {
      bindIdentity: vi.fn(),
      hasStoredAuthorization: vi.fn(async () => true),
    } as unknown as ClientServerApi,
    gatewayWithCarrier(),
    logger(),
  )
  await runtime.start()
  const peer = await identities.trustPeer({
    deviceId: randomUUID(),
    name: 'Studio Host',
    platform: 'darwin',
    publicKey: generateKeyPair().publicKey,
    membershipId: 'membership-direct-control',
  })
  const control = (endpoint: string, payload: unknown = {}) =>
    runtime.handleControl(endpoint, payload, new AbortController().signal)
  return { runtime, identities, peer, control }
}

describe('Direct client control endpoints', () => {
  it('rejects malformed Direct payloads before touching persisted state', async () => {
    const { control, peer } = await fixture()
    const cases: Array<{ name: string; endpoint: string; payload: unknown }> = [
      { name: 'host add without payload fields', endpoint: 'direct.host.add', payload: {} },
      { name: 'host add without address', endpoint: 'direct.host.add', payload: { hostDeviceId: peer.deviceId } },
      { name: 'host add with unknown field', endpoint: 'direct.host.add', payload: { hostDeviceId: peer.deviceId, endpoint: '100.64.0.9:47400', extra: true } },
      { name: 'host remove with non-string id', endpoint: 'direct.host.remove', payload: { hostDeviceId: 42 } },
      { name: 'connect without host', endpoint: 'direct.connect', payload: {} },
      { name: 'connect with non-string address', endpoint: 'direct.connect', payload: { hostDeviceId: peer.deviceId, endpoint: 7 } },
      { name: 'connect with unknown field', endpoint: 'direct.connect', payload: { hostDeviceId: peer.deviceId, hostName: 'spoofed' } },
    ]
    await runScenarios(cases.map(row => ({
      name: row.name,
      run: async () => {
        expect(remoteCode(await control(row.endpoint, row.payload))).toBe('INVALID_MESSAGE')
      },
    })))
    const listed = await control('direct.hosts.list')
    expect(listed.ok).toBe(true)
    expect(listed.ok && (listed.value as { hosts: unknown[] }).hosts).toEqual([])
  })

  it('rejects unpinned hosts and non-tailnet Direct addresses', async () => {
    const { control, peer } = await fixture()
    const cases: Array<{ name: string; endpoint: string; payload: unknown; code: string }> = [
      { name: 'unpinned host', endpoint: 'direct.host.add', payload: { hostDeviceId: randomUUID(), endpoint: '100.64.0.9:47400' }, code: 'DIRECT_HOST_UNKNOWN' },
      { name: 'public IPv4', endpoint: 'direct.host.add', payload: { hostDeviceId: peer.deviceId, endpoint: '203.0.113.9:47400' }, code: 'DIRECT_ENDPOINT_INVALID' },
      { name: 'non-tailnet hostname', endpoint: 'direct.host.add', payload: { hostDeviceId: peer.deviceId, endpoint: 'example.com:47400' }, code: 'DIRECT_ENDPOINT_INVALID' },
      { name: 'unknown direct connect host', endpoint: 'direct.connect', payload: { hostDeviceId: randomUUID() }, code: 'DIRECT_HOST_UNKNOWN' },
    ]
    await runScenarios(cases.map(row => ({
      name: row.name,
      run: async () => {
        expect(remoteCode(await control(row.endpoint, row.payload))).toBe(row.code)
      },
    })))
    const listed = await control('direct.hosts.list')
    expect(listed.ok && (listed.value as { hosts: unknown[] }).hosts).toEqual([])
  })

  it('saves, lists and removes a Direct host without exposing identity keys', async () => {
    const { control, peer } = await fixture()

    const before = await control('direct.hosts.list')
    expect(before.ok && (before.value as { candidates: Array<{ hostDeviceId: string }> }).candidates)
      .toContainEqual(expect.objectContaining({ hostDeviceId: peer.deviceId }))

    const added = await control('direct.host.add', { hostDeviceId: peer.deviceId, endpoint: '100.64.0.9:47400' })
    expect(added.ok).toBe(true)
    const view = added.ok ? added.value as {
      hosts: Array<Record<string, unknown>>
      candidates: Array<Record<string, unknown>>
    } : undefined
    expect(view?.hosts).toHaveLength(1)
    expect(view?.hosts[0]).toMatchObject({
      hostDeviceId: peer.deviceId,
      hostName: 'Studio Host',
      platform: 'darwin',
    })
    expect(view?.hosts[0]?.endpoint).toMatch(/^ws:\/\/100\.64\.0\.9:47400\/direct\/v1$/)
    // No identity keys are echoed to the UI/control surface.
    expect(JSON.stringify(view)).not.toContain('publicKey')
    expect(JSON.stringify(view)).not.toContain(peer.publicKey)

    const removed = await control('direct.host.remove', { hostDeviceId: peer.deviceId })
    expect(removed.ok).toBe(true)
    expect(removed.ok && (removed.value as { hosts: unknown[] }).hosts).toEqual([])
  })

  it('answers direct.disconnect as a no-op when no Direct carrier is active', async () => {
    const { control } = await fixture()
    const result = await control('direct.disconnect')
    expect(result.ok).toBe(true)
    expect(result.ok && (result.value as { connected: boolean }).connected).toBe(false)
  })
})
