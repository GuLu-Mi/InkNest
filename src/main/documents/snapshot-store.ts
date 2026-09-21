import { copy } from '../../shared/copy'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { fail, readBounded, sameVersion } from './reader'
export const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
export const HASH = /^[a-f0-9]{64}$/u
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
export function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
export interface SnapshotRecord { snapshot: string; contentHash: string; byteLength: number; createdAt: string }
export function validRecord(value: unknown, extension: 'txt' | 'bin'): value is SnapshotRecord {
  const r = value as SnapshotRecord
  return !!r && typeof r.snapshot === 'string' && r.snapshot.endsWith(`.${extension}`) && ID.test(r.snapshot.slice(0, -4)) && typeof r.contentHash === 'string' && HASH.test(r.contentHash) && Number.isSafeInteger(r.byteLength) && r.byteLength >= 0 && r.byteLength <= 10 * 1024 * 1024 && timestamp(r.createdAt)
}
export interface SnapshotOptions { beforeManifest?: () => void | Promise<void>; maxBytes?: number }
/** Only registered UUID directories and explicitly indexed names can be read or removed. */
export class SnapshotStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(readonly root: string, readonly options: SnapshotOptions = {}) {}
  serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.tail.then(operation); this.tail = result.then(() => {}, () => {}); return result }
  async directory(id?: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const root = await realpath(this.root)
    if ((await lstat(this.root)).isSymbolicLink()) fail('CORRUPT_DATA', copy.backupDirectoryLink)
    if (!id) return root
    if (!ID.test(id)) fail('INVALID_REQUEST', copy.invalidBackupId)
    const path = join(root, id)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail('CORRUPT_DATA', copy.invalidBackupDirectory)
    return path
  }
  async create(id: string): Promise<void> { if (!ID.test(id)) fail('INVALID_REQUEST', copy.invalidBackupId); await mkdir(join(await this.directory(), id), { mode: 0o700 }); await this.flush(await this.directory()) }
  async ids(): Promise<string[]> { return (await readdir(await this.directory(), { withFileTypes: true })).filter(e => e.isDirectory() && ID.test(e.name)).map(e => e.name) }
  async contentBytes(): Promise<number> {
    let total = 0
    for (const id of await this.ids()) {
      const dir = await this.directory(id)
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (['manifest.json', 'discarded.json'].includes(entry.name)) continue
        const info = await lstat(join(dir, entry.name))
        // Unindexed/unknown files consume space but never become deletion authority.
        if (info.isFile()) total += info.size
      }
    }
    return total
  }
  async bytes(id: string, name: string, max: number): Promise<Buffer> {
    if (!['manifest.json', 'discarded.json'].includes(name) && !(/\.(txt|bin)$/u.test(name) && ID.test(name.slice(0, -4)))) fail('CORRUPT_DATA', copy.invalidBackupFilename)
    const path = join(await this.directory(id), name)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try { const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1) fail('CORRUPT_DATA', copy.invalidBackupFile); const bytes = await readBounded(handle, before.size, max); if (!sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(path))) fail('CORRUPT_DATA', copy.backupChanged); return bytes } finally { await handle.close() }
  }
  async json(id: string, name = 'manifest.json'): Promise<unknown> { try { return JSON.parse((await this.bytes(id, name, 1024 * 1024)).toString('utf8')) as unknown } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; fail('CORRUPT_DATA', copy.corruptBackupIndex) } }
  async verified(id: string, record: SnapshotRecord): Promise<Buffer> {
    try { const bytes = await this.bytes(id, record.snapshot, 10 * 1024 * 1024); if (bytes.length !== record.byteLength || digest(bytes) !== record.contentHash) fail('CORRUPT_DATA', copy.backupIntegrityFailed); return bytes } catch { fail('CORRUPT_DATA', copy.backupIncomplete) }
  }
  async content(id: string, bytes: Buffer, extension: 'txt' | 'bin', now: number): Promise<SnapshotRecord> {
    const record = { snapshot: `${randomUUID()}.${extension}`, contentHash: digest(bytes), byteLength: bytes.length, createdAt: new Date(now).toISOString() }
    await writeFileAtomic(join(await this.directory(id), record.snapshot), bytes, { fsync: true, mode: 0o600 })
    await this.verified(id, record); await this.flush(await this.directory(id)); return record
  }
  async publish(id: string, value: unknown, marker = false): Promise<void> {
    const name = marker ? 'discarded.json' : 'manifest.json'
    try { const stat = await lstat(join(await this.directory(id), name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('CORRUPT_DATA', copy.backupIndexLink) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await this.options.beforeManifest?.()
    await writeFileAtomic(join(await this.directory(id), marker ? 'discarded.json' : 'manifest.json'), JSON.stringify(value), { fsync: true, mode: 0o600 })
    await this.flush(await this.directory(id))
  }
  async removeContent(id: string, records: SnapshotRecord[]): Promise<void> {
    for (const record of records) { await this.verified(id, record); await unlink(join(await this.directory(id), record.snapshot)) }
  }
  /** A published retirement list authorizes retrying deletion, including after a prior unlink succeeded. */
  async removeRetiredContent(id: string, record: SnapshotRecord): Promise<void> {
    try {
      const bytes = await this.bytes(id, record.snapshot, 10 * 1024 * 1024)
      if (bytes.length !== record.byteLength || digest(bytes) !== record.contentHash) fail('CORRUPT_DATA', copy.backupIntegrityFailed)
      await unlink(join(await this.directory(id), record.snapshot))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private async flush(path: string): Promise<void> { if (process.platform === 'win32') return; const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
}
