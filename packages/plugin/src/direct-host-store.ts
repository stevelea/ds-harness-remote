import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_DIRECT_PORT } from './config.js'
import { parseDirectEndpoint } from './direct-tailscale.js'
import type { IdentityStore } from './identity-store.js'
import { uuidV7 } from './ids.js'

/**
 * Client-side persistence for saved Direct (Tailscale) Hosts.
 *
 * A Direct address is stored only for a Host identity that this device already
 * pinned during the normal Server authorization. The record therefore includes
 * the pinned public key: `direct.connect` resolves the Host from the identity
 * store again and fails closed when the pinned key changed, so a rewritten
 * `direct-hosts.json` can never redirect a Direct session to another peer.
 * No tokens are stored here, only the address and the non-secret identity
 * fingerprint data of the pinned peer.
 */
export const MAX_DIRECT_HOSTS = 16

const MAX_ENDPOINT_LENGTH = 512
const MAX_HOST_NAME_LENGTH = 80
const MAX_PLATFORM_LENGTH = 40
const MAX_PUBLIC_KEY_LENGTH = 128

const directHostEntrySchema = z.object({
  hostDeviceId: z.string().uuid(),
  hostName: z.string().min(1).max(MAX_HOST_NAME_LENGTH),
  platform: z.string().min(1).max(MAX_PLATFORM_LENGTH).optional(),
  publicKey: z.string().min(1).max(MAX_PUBLIC_KEY_LENGTH).regex(/^[A-Za-z0-9_-]+$/),
  endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH),
  addedAt: z.number().int().nonnegative(),
  lastConnectedAt: z.number().int().nonnegative().optional(),
}).strict()

const directHostsFileSchema = z.object({
  schemaVersion: z.literal(1),
  hosts: z.array(directHostEntrySchema).max(MAX_DIRECT_HOSTS),
}).strict().refine(
  value => new Set(value.hosts.map(host => host.hostDeviceId)).size === value.hosts.length,
  { message: 'duplicate Direct hosts' },
)

/** Saved Direct (Tailscale) Host record. */
export type DirectHostEntry = z.infer<typeof directHostEntrySchema>

export interface DirectHostInput {
  hostDeviceId: string
  /** `host:port`, `ws://host:port` or a MagicDNS name; validated before saving. */
  endpoint: string
  hostName?: string
  platform?: string
  /** Must match the pinned Host identity when provided. */
  publicKey?: string
}

export interface DirectHostStoreOptions {
  /** The Client identity store whose trusted peers authorize Direct hosts. */
  identities: IdentityStore
  /** Defaults to the identity store directory. */
  directory?: string
  /** Test seam. */
  now?: () => number
}

export class DirectHostStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DirectHostStoreError'
  }
}

/**
 * Atomically persisted `direct-hosts.json` (0600) next to the Client identity.
 * Every mutation re-reads nothing: this class owns the file and serializes
 * writes, so concurrent control calls cannot interleave a partial update.
 */
export class DirectHostStore {
  readonly path: string
  private readonly directory: string
  private entries: DirectHostEntry[] = []
  private loaded = false
  private loading?: Promise<void>
  private writeFlight: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly options: DirectHostStoreOptions) {
    this.now = options.now ?? Date.now
    this.directory = options.directory ?? options.identities.directory
    this.path = join(this.directory, 'direct-hosts.json')
  }

  /** Saved hosts for currently pinned peers, most recently connected first. */
  list(): DirectHostEntry[] {
    return this.sorted().map(entry => ({ ...entry }))
  }

  get(hostDeviceId: string): DirectHostEntry | undefined {
    const entry = this.entries.find(item => item.hostDeviceId === hostDeviceId)
    return entry === undefined ? undefined : { ...entry }
  }

  async upsert(input: DirectHostInput): Promise<DirectHostEntry> {
    const hostDeviceId = parseDeviceId(input.hostDeviceId)
    const endpoint = parseEndpoint(input.endpoint)
    const peer = this.options.identities.trustedPeer(hostDeviceId)
    if (peer === undefined) {
      throw new DirectHostStoreError(
        'DIRECT_HOST_UNKNOWN',
        'This Host is not authorized on this device. Authorize it through the Server before saving a Direct address.',
      )
    }
    const publicKey = input.publicKey === undefined ? peer.publicKey : parsePublicKey(input.publicKey)
    if (publicKey !== peer.publicKey) {
      throw new DirectHostStoreError(
        'DIRECT_HOST_UNPINNED',
        'The saved Direct host does not match the pinned Host identity.',
      )
    }
    const hostName = parseDisplayName(input.hostName) ?? peer.name
    const platform = parseDisplayName(input.platform) ?? peer.platform
    return this.mutate(() => {
      const existing = this.entries.find(entry => entry.hostDeviceId === hostDeviceId)
      if (existing === undefined && this.entries.length >= MAX_DIRECT_HOSTS) {
        throw new DirectHostStoreError('DIRECT_HOST_LIMIT', `At most ${MAX_DIRECT_HOSTS} Direct hosts can be saved.`)
      }
      const entry: DirectHostEntry = {
        hostDeviceId,
        hostName,
        platform,
        publicKey,
        endpoint,
        addedAt: existing?.addedAt ?? this.now(),
        ...(existing?.lastConnectedAt === undefined ? {} : { lastConnectedAt: existing.lastConnectedAt }),
      }
      this.entries = [...this.entries.filter(item => item.hostDeviceId !== hostDeviceId), entry]
      return { ...entry }
    })
  }

  async remove(hostDeviceId: string): Promise<boolean> {
    const id = parseDeviceId(hostDeviceId)
    return this.mutate(() => {
      const next = this.entries.filter(entry => entry.hostDeviceId !== id)
      if (next.length === this.entries.length) return false
      this.entries = next
      return true
    })
  }

  async markConnected(hostDeviceId: string): Promise<DirectHostEntry | undefined> {
    const id = parseDeviceId(hostDeviceId)
    return this.mutate(() => {
      const existing = this.entries.find(entry => entry.hostDeviceId === id)
      if (existing === undefined) return undefined
      const entry: DirectHostEntry = { ...existing, lastConnectedAt: this.now() }
      this.entries = this.entries.map(item => item.hostDeviceId === id ? entry : item)
      return { ...entry }
    })
  }

  /** Load from disk once; drops entries whose peer is no longer pinned. */
  async load(): Promise<DirectHostEntry[]> {
    if (this.loaded) return this.list()
    this.loading ??= this.readFile().finally(() => { this.loading = undefined })
    await this.loading
    return this.list()
  }

  private async readFile(): Promise<void> {
    let parsed: z.infer<typeof directHostsFileSchema>
    try {
      const text = await readFile(this.path, 'utf8')
      parsed = parseFile(text)
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.entries = []
        this.loaded = true
        return
      }
      throw new DirectHostStoreError('DIRECT_HOSTS_INVALID', 'The saved Direct host list is unreadable or invalid.')
    }
    const pinned = parsed.hosts.filter(entry => {
      const peer = this.options.identities.trustedPeer(entry.hostDeviceId)
      return peer !== undefined && peer.publicKey === entry.publicKey
    })
    this.entries = pinned
    this.loaded = true
    if (pinned.length !== parsed.hosts.length) await this.persist()
  }

  private async mutate<T>(mutation: () => T): Promise<T> {
    const run = this.writeFlight.then(async () => {
      await this.load()
      const value = mutation()
      await this.persist()
      return value
    })
    this.writeFlight = run.then(() => undefined, () => undefined)
    return run
  }

  private async persist(): Promise<void> {
    const payload = {
      schemaVersion: 1 as const,
      hosts: this.sorted(),
    }
    await atomicJsonWrite(this.path, payload, 0o600)
  }

  private sorted(): DirectHostEntry[] {
    return [...this.entries].sort((left, right) =>
      (right.lastConnectedAt ?? right.addedAt) - (left.lastConnectedAt ?? left.addedAt))
  }
}

/** Normalize and validate a user-entered Direct address, returning a canonical URL. */
export function normalizeDirectEndpoint(input: string, defaultPort = DEFAULT_DIRECT_PORT): string {
  return parseEndpoint(input, defaultPort)
}

function parseEndpoint(input: string, defaultPort = DEFAULT_DIRECT_PORT): string {
  if (typeof input !== 'string' || input.trim() === '' || input.length > MAX_ENDPOINT_LENGTH) {
    throw new DirectHostStoreError('DIRECT_ENDPOINT_INVALID', 'A Direct host address is required.')
  }
  try {
    return parseDirectEndpoint(input, defaultPort).url
  } catch (error: unknown) {
    throw new DirectHostStoreError(
      'DIRECT_ENDPOINT_INVALID',
      error instanceof Error ? error.message : 'The Direct host address is invalid.',
    )
  }
}

function parseDeviceId(value: string): string {
  if (typeof value !== 'string' || !directHostEntrySchema.shape.hostDeviceId.safeParse(value).success) {
    throw new DirectHostStoreError('DIRECT_HOST_INVALID', 'A valid Host device ID is required.')
  }
  return value
}

function parsePublicKey(value: string): string {
  if (typeof value !== 'string' || !directHostEntrySchema.shape.publicKey.safeParse(value).success) {
    throw new DirectHostStoreError('DIRECT_HOST_INVALID', 'The Host identity key is invalid.')
  }
  return value
}

function parseDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_HOST_NAME_LENGTH) return undefined
  return trimmed
}

function parseFile(text: string): z.infer<typeof directHostsFileSchema> {
  try {
    return directHostsFileSchema.parse(JSON.parse(text))
  } catch (error: unknown) {
    throw new DirectHostStoreError('DIRECT_HOSTS_INVALID', 'The saved Direct host list is unreadable or invalid.')
  }
}

async function atomicJsonWrite(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' })
  await chmod(temporary, mode)
  await rename(temporary, path)
  await chmod(path, mode)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
