import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@dsh-remote/crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import {
  DirectHostStore,
  DirectHostStoreError,
  MAX_DIRECT_HOSTS,
  type DirectHostStoreOptions,
} from '../src/direct-host-store.js'
import { IdentityStore } from '../src/identity-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

interface Fixture {
  directory: string
  identities: IdentityStore
  store: DirectHostStore
  peer: { deviceId: string; name: string; platform: string; publicKey: string }
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-hosts-'))
  directories.push(directory)
  const identities = new IdentityStore({ directory })
  await identities.loadOrCreate('Direct client')
  const peer = await identities.trustPeer({
    deviceId: randomUUID(),
    name: 'Studio Host',
    platform: 'darwin',
    publicKey: generateKeyPair().publicKey,
    membershipId: 'membership-direct-store',
  })
  return { directory, identities, store: new DirectHostStore(storeOptions(identities)), peer }
}

function storeOptions(identities: IdentityStore): DirectHostStoreOptions {
  return { identities, now: () => 1_700_000_000_000 }
}

describe('Direct host store', () => {
  it('persists a pinned Direct host with 0600 and round-trips it', async () => {
    const { directory, identities, store, peer } = await fixture()
    const saved = await store.upsert({ hostDeviceId: peer.deviceId, endpoint: '100.64.0.5:47400' })
    expect(saved).toMatchObject({
      hostDeviceId: peer.deviceId,
      hostName: 'Studio Host',
      platform: 'darwin',
      publicKey: peer.publicKey,
    })
    expect(saved.endpoint).toMatch(/^ws:\/\/100\.64\.0\.5:47400\/direct\/v1$/)
    expect(store.list()).toHaveLength(1)
    expect(store.get(peer.deviceId)).toMatchObject({ hostDeviceId: peer.deviceId })

    const file = join(directory, 'direct-hosts.json')
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    const raw = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number; hosts: unknown[] }
    expect(raw.schemaVersion).toBe(1)
    expect(raw.hosts).toHaveLength(1)

    const reopened = new DirectHostStore(storeOptions(identities))
    await reopened.load()
    expect(reopened.list()).toEqual([saved])
  })

  it('records the last connection and persists removals', async () => {
    const { directory, identities, store, peer } = await fixture()
    await store.upsert({ hostDeviceId: peer.deviceId, endpoint: '100.64.0.5:47400' })
    const connected = await store.markConnected(peer.deviceId)
    expect(connected?.lastConnectedAt).toBe(1_700_000_000_000)

    const reopened = new DirectHostStore(storeOptions(identities))
    await reopened.load()
    expect(reopened.get(peer.deviceId)?.lastConnectedAt).toBe(1_700_000_000_000)

    expect(await reopened.remove(peer.deviceId)).toBe(true)
    expect(await reopened.remove(peer.deviceId)).toBe(false)
    expect(reopened.list()).toEqual([])
    const raw = JSON.parse(await readFile(join(directory, 'direct-hosts.json'), 'utf8')) as { hosts: unknown[] }
    expect(raw.hosts).toEqual([])
  })

  it('rejects hosts that are not pinned or that present another identity key', async () => {
    const { identities, store, peer } = await fixture()
    const cases: Array<{ name: string; input: { hostDeviceId: string; endpoint: string; publicKey?: string }; code: string }> = [
      { name: 'unknown device', input: { hostDeviceId: randomUUID(), endpoint: '100.64.0.5:47400' }, code: 'DIRECT_HOST_UNKNOWN' },
      { name: 'pinned device with another key', input: { hostDeviceId: peer.deviceId, endpoint: '100.64.0.5:47400', publicKey: generateKeyPair().publicKey }, code: 'DIRECT_HOST_UNPINNED' },
      { name: 'invalid device id', input: { hostDeviceId: 'not-a-uuid', endpoint: '100.64.0.5:47400' }, code: 'DIRECT_HOST_INVALID' },
    ]
    await runScenarios(cases.map(row => ({
      name: row.name,
      run: async () => {
        await expect(store.upsert(row.input)).rejects.toMatchObject({ code: row.code })
        expect(store.list()).toEqual([])
      },
    })))
    // A pinned device id without a stray key still validates the identity store.
    expect(identities.trustedPeer(peer.deviceId)?.publicKey).toBe(peer.publicKey)
  })

  it('rejects public addresses, HTTP URLs, invalid ports and paths', async () => {
    const { store, peer } = await fixture()
    const cases = [
      ['private LAN IPv4', '192.168.1.10:47400'],
      ['public IPv4', '203.0.113.7:47400'],
      ['HTTP URL', 'https://100.64.0.5:47400'],
      ['bare public hostname', 'example.com:47400'],
      ['privileged port', '100.64.0.5:80'],
      ['path suffix', '100.64.0.5:47400/path'],
      ['credentials', 'user@100.64.0.5:47400'],
      ['missing address', '   '],
    ] as const
    await runScenarios(cases.map(([name, endpoint]) => ({
      name,
      run: async () => {
        const failure = store.upsert({ hostDeviceId: peer.deviceId, endpoint })
        await expect(failure).rejects.toBeInstanceOf(DirectHostStoreError)
        await expect(failure).rejects.toMatchObject({ code: 'DIRECT_ENDPOINT_INVALID' })
      },
    })))
    expect(store.list()).toEqual([])
  })

  it('caps the saved host list and still updates an existing row at the cap', async () => {
    const { identities, store } = await fixture()
    const peers = []
    for (let index = 0; index < MAX_DIRECT_HOSTS; index += 1) {
      peers.push(await identities.trustPeer({
        deviceId: randomUUID(),
        name: `Host ${index}`,
        platform: 'linux',
        publicKey: generateKeyPair(new Uint8Array(32).fill(index + 1)).publicKey,
      }))
    }
    for (const [index, peer] of peers.entries()) {
      await store.upsert({ hostDeviceId: peer.deviceId, endpoint: `100.64.0.${index + 10}:47400` })
    }
    expect(store.list()).toHaveLength(MAX_DIRECT_HOSTS)
    await expect(store.upsert({ hostDeviceId: peers[0]!.deviceId, endpoint: '100.64.0.99:47400' }))
      .resolves.toMatchObject({ hostDeviceId: peers[0]!.deviceId })

    const extra = await identities.trustPeer({
      deviceId: randomUUID(),
      name: 'Host overflow',
      platform: 'linux',
      publicKey: generateKeyPair(new Uint8Array(32).fill(99)).publicKey,
    })
    await expect(store.upsert({ hostDeviceId: extra.deviceId, endpoint: '100.64.1.1:47400' }))
      .rejects.toMatchObject({ code: 'DIRECT_HOST_LIMIT' })
  })

  it('drops saved hosts whose peer is no longer pinned', async () => {
    const { identities, store, peer } = await fixture()
    await store.upsert({ hostDeviceId: peer.deviceId, endpoint: '100.64.0.5:47400' })
    expect(store.list()).toHaveLength(1)

    await identities.revokePeer(peer.deviceId)
    const reopened = new DirectHostStore(storeOptions(identities))
    await reopened.load()
    expect(reopened.list()).toEqual([])
  })
})
