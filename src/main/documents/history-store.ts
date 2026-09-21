import { copy } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { HistoryCommit, HistoryEntry, HistoryListing, HistorySnapshot, HistorySource, SaveRequest } from '../../shared/contracts'
import type { DocumentSession } from './registry'
import { fail, FileFailure } from './reader'
import { decodeUtf8 } from './codec'
import { EDITABLE_DOCUMENT_MAX_BYTES } from '../../shared/limits'
import { canMergeAuto, type AutoGroup } from './history-policy'
import { digest, exact, HASH, RETENTION_MS, SnapshotStore, timestamp, validRecord, type SnapshotOptions, type SnapshotRecord } from './snapshot-store'
interface HistoryRecord extends SnapshotRecord { capturedToken: string; source: HistorySource; groupStartedAt: string | null; sealed: boolean }
interface Manifest { schemaVersion: 2; canonicalPath: string; generation: number; snapshots: HistoryRecord[]; retired: HistoryRecord[] }
interface Indexed { id: string; manifest: Manifest }
export interface HistoryWriteContext { session: DocumentSession; targetPath: string; requestId: string; revision: number; source: Exclude<HistorySource, 'baseline' | 'legacy'>; now: number }
export interface HistoryProtection { id: string; generation: number; release(): void }
interface HistoryOptions extends SnapshotOptions { changed?: (path: string, generation: number) => void; maintenanceChanged?: (path: string, failed: boolean) => void }
const sources = new Set(['baseline', 'auto', 'manual', 'close', 'save-as', 'restore', 'legacy'])
const owner = (s: DocumentSession) => `${s.document.docId}/${s.document.epoch}`
const operation = (c: HistoryWriteContext) => `${owner(c.session)}/${c.targetPath}/${c.requestId}/${c.revision}/${c.source}`
const historyError = () => ({ code: 'HISTORY_FAILED' as const, message: copy.historyWriteFailed, retryable: true })
export class HistoryStore {
  private restores = 0
  private clearing = false
  private readonly store: SnapshotStore
  private readonly groups = new WeakMap<DocumentSession, AutoGroup>()
  private readonly leases = new Map<string, Map<string, number>>()
  constructor(root: string, private readonly options: HistoryOptions = {}) { this.store = new SnapshotStore(root, options) }
  acquireRestore(): () => void {
    if (this.clearing) fail('FILE_BUSY', copy.processingWait)
    this.restores++
    let released = false
    return () => { if (!released) { released = true; this.restores-- } }
  }
  async clearConfirmed(confirm: () => Promise<boolean>): Promise<boolean> {
    if (this.restores || this.clearing || this.leases.size) fail('FILE_BUSY', copy.processingWait)
    this.clearing = true
    try { if (!await confirm()) return false; await this.clearStorage(); return true }
    finally { this.clearing = false }
  }
  private async manifest(id: string): Promise<Manifest> {
    const value = await this.store.json(id)
    const legacy = exact(value, ['schemaVersion', 'canonicalPath', 'snapshots']) && value.schemaVersion === 1
    if (!legacy && !(exact(value, ['schemaVersion', 'canonicalPath', 'generation', 'snapshots', 'retired']) && value.schemaVersion === 2)) fail('CORRUPT_DATA', copy.corruptHistoryIndex)
    const v = value as Record<string, unknown>
    if (typeof v.canonicalPath !== 'string' || !isAbsolute(v.canonicalPath) || !Array.isArray(v.snapshots) || v.snapshots.length > (legacy ? 20 : 100)) fail('CORRUPT_DATA', copy.corruptHistoryIndex)
    const valid = (r: unknown): r is HistoryRecord => exact(r, legacy ? ['snapshot', 'contentHash', 'byteLength', 'createdAt', 'capturedToken'] : ['snapshot', 'contentHash', 'byteLength', 'createdAt', 'capturedToken', 'source', 'groupStartedAt', 'sealed']) && validRecord(r, 'bin') && typeof r.capturedToken === 'string' && HASH.test(r.capturedToken) && (legacy || typeof r.source === 'string' && sources.has(r.source) && typeof r.sealed === 'boolean' && (r.groupStartedAt === null || timestamp(r.groupStartedAt)) && (r.source === 'auto' || r.sealed === true && r.groupStartedAt === null) && (r.source !== 'auto' || timestamp(r.groupStartedAt)))
    if (!v.snapshots.every(valid) || !legacy && (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || !Array.isArray(v.retired) || v.retired.length > 1000 || !v.retired.every(valid))) fail('CORRUPT_DATA', copy.corruptHistoryIndex)
    const snapshots = v.snapshots as HistoryRecord[]; const retired = legacy ? [] : v.retired as HistoryRecord[]
    if (new Set([...snapshots, ...retired].map(r => r.snapshot)).size !== snapshots.length + retired.length) fail('CORRUPT_DATA', copy.duplicateHistory)
    return { schemaVersion: 2, canonicalPath: v.canonicalPath, generation: legacy ? 0 : v.generation as number, snapshots: legacy ? snapshots.map(r => ({ ...r, source: 'legacy', groupStartedAt: null, sealed: true })) : snapshots, retired }
  }
  private async all(): Promise<Indexed[]> {
    const result: Indexed[] = []
    for (const id of await this.store.ids()) { try { result.push({ id, manifest: await this.manifest(id) }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    return result
  }
  private async target(all: Indexed[], path: string): Promise<Indexed> {
    let target = all.find(i => i.manifest.canonicalPath === path)
    if (!target) { target = { id: randomUUID(), manifest: { schemaVersion: 2, canonicalPath: path, generation: 0, snapshots: [], retired: [] } }; await this.store.create(target.id); all.push(target) }
    return target
  }
  private async publish(item: Indexed, changed = true): Promise<void> {
    if (item.manifest.retired.length > 1000 || item.manifest.generation >= Number.MAX_SAFE_INTEGER) fail('HISTORY_FAILED', copy.historyCapacity)
    if (changed) item.manifest.generation++
    await this.store.publish(item.id, item.manifest)
    if (changed) { try { this.options.changed?.(item.manifest.canonicalPath, item.manifest.generation) } catch { /* Notifications cannot undo a committed index. */ } }
  }
  private lease(item: Indexed, record: HistoryRecord, key: string): HistoryProtection {
    const owners = this.leases.get(record.snapshot) ?? new Map<string, number>(); this.leases.set(record.snapshot, owners); owners.set(key, (owners.get(key) ?? 0) + 1)
    let released = false
    return { id: record.snapshot.slice(0, -4), generation: item.manifest.generation, release: () => {
      if (released) return; released = true
      const count = owners.get(key)! - 1
      if (count) owners.set(key, count); else owners.delete(key)
      if (!owners.size) this.leases.delete(record.snapshot)
    } }
  }
  private protected(record: HistoryRecord, except?: string): boolean { return [...(this.leases.get(record.snapshot)?.keys() ?? [])].some(key => key !== except) }
  private async cleanup(item: Indexed): Promise<void> {
    const retained: HistoryRecord[] = []
    for (const r of item.manifest.retired) {
      if (this.protected(r)) { retained.push(r); continue }
      try { await this.store.removeRetiredContent(item.id, r) } catch { retained.push(r) }
    }
    if (retained.length === item.manifest.retired.length) {
      this.warn(item, retained.some(r => !this.protected(r)))
      return
    }
    const old = item.manifest.retired; item.manifest.retired = retained
    try { await this.publish(item, false); this.warn(item, retained.some(r => !this.protected(r))) } catch { item.manifest.retired = old; this.warn(item) }
  }
  private warn(item: Indexed, failed = true): void { try { this.options.maintenanceChanged?.(item.manifest.canonicalPath, failed) } catch { /* Maintenance reporting is best effort. */ } }
  private async retire(item: Indexed, records: HistoryRecord[]): Promise<void> {
    if (!records.length) return
    item.manifest.snapshots = item.manifest.snapshots.filter(r => !records.includes(r)); item.manifest.retired.push(...records)
    await this.publish(item); await this.cleanup(item)
  }
  private async maintain(all: Indexed[], now: number): Promise<void> {
    for (const item of all) {
      await this.cleanup(item)
      await this.retire(item, item.manifest.snapshots.filter(r => now - Date.parse(r.createdAt) > RETENTION_MS && !this.protected(r)))
    }
  }
  private async room(all: Indexed[], target: Indexed, bytes: number, keep: Set<string>, addedNodes = 1): Promise<void> {
    const max = this.options.maxBytes ?? 200 * 1024 * 1024
    // Re-read actual physical bytes after each deletion; failed unlink never creates fictitious capacity.
    const queues = all.map(item => ({ item, records: [...item.manifest.snapshots].reverse().filter(r => !keep.has(r.snapshot) && !this.protected(r)) }))
    while (true) {
      const capacityNeeded = await this.store.contentBytes() + bytes > max
      if (!capacityNeeded && target.manifest.snapshots.length + addedNodes <= 100) break
      // Compare only each file's oldest eligible commit. Wall-clock rollback must
      // never reorder commits within one document.
      const next = queues.filter(q => q.records.length && (capacityNeeded || q.item === target))
        .sort((a, b) => Date.parse(a.records[0]!.createdAt) - Date.parse(b.records[0]!.createdAt))[0]
      if (!next) break
      const entry = { item: next.item, r: next.records.shift()! }
      await this.retire(entry.item, [entry.r])
    }
    if (await this.store.contentBytes() + bytes > max || target.manifest.snapshots.length + addedNodes > 100) fail('HISTORY_FAILED', copy.historyCapacity)
  }
  async pin(session: DocumentSession, id: string): Promise<HistoryProtection> {
    return this.store.serial(async () => {
      if (this.clearing) fail('FILE_BUSY', copy.processingWait)
      const item = (await this.all()).find(i => i.manifest.canonicalPath === session.path)
      const record = item?.manifest.snapshots.find(r => r.snapshot === `${id}.bin`)
      if (!item || !record) fail('INVALID_REQUEST', copy.historyMismatch)
      await this.store.verified(item.id, record)
      return this.lease(item, record, randomUUID())
    })
  }
  protectBeforeWrite(context: HistoryWriteContext, bytes: Buffer, token: string, seal: boolean): Promise<HistoryProtection> {
    return this.store.serial(async () => {
      try {
        if (this.clearing) fail('FILE_BUSY', copy.processingWait)
        const all = await this.all(); await this.maintain(all, context.now)
        const item = await this.target(all, context.targetPath)
        let record = item.manifest.snapshots.find(r => r.contentHash === digest(bytes))
        if (record) {
          await this.store.verified(item.id, record)
          if (seal && !record.sealed) { record.sealed = true; await this.publish(item) }
        } else {
          await this.room(all, item, bytes.length, new Set())
          record = { ...await this.store.content(item.id, bytes, 'bin', context.now), capturedToken: token, source: 'baseline', groupStartedAt: null, sealed: true }
          item.manifest.snapshots.unshift(record); await this.publish(item)
        }
        return this.lease(item, record, operation(context))
      } catch { fail('HISTORY_FAILED', copy.historyWriteFailed) }
    })
  }
  // Existing internal export/fixture capture: a protected old version, never an automatic saved-version event.
  async captureBeforeWrite(session: DocumentSession, bytes: Buffer, trigger: SaveRequest['trigger'], now: number, token = session.document.diskToken!): Promise<void> {
    const lease = await this.protectBeforeWrite({ session, targetPath: session.path, requestId: randomUUID(), revision: session.document.revision, source: trigger, now }, bytes, token, true)
    lease.release()
  }
  recordSaved(context: HistoryWriteContext, bytes: Buffer, token: string, onlyExisting = false): Promise<HistoryCommit> {
    return this.store.serial(async () => {
      let generation = 0
      try {
        if (this.clearing) fail('FILE_BUSY', copy.processingWait)
        const all = await this.all(); await this.maintain(all, context.now)
        if (onlyExisting && !all.some(i => i.manifest.canonicalPath === context.targetPath)) return { state: 'unchanged', generation: 0, error: null }
        const item = await this.target(all, context.targetPath); generation = item.manifest.generation
        const previous = item.manifest.snapshots[0]
        if (previous?.contentHash === digest(bytes)) {
          await this.store.verified(item.id, previous)
          if (context.source !== 'auto' && previous.source === 'auto' && !previous.sealed) {
            previous.source = context.source; previous.sealed = true; previous.groupStartedAt = null; previous.createdAt = new Date(context.now).toISOString()
            await this.publish(item); this.groups.delete(context.session)
            return { state: 'recorded', generation: item.manifest.generation, error: null }
          }
          if (context.source !== 'auto') this.groups.delete(context.session)
          return { state: 'unchanged', generation, error: null }
        }
        if (onlyExisting) return { state: 'unchanged', generation, error: null }
        const group = this.groups.get(context.session) ?? null
        const merge = !!previous && previous.source === 'auto' && !previous.sealed && context.source === 'auto' && group?.snapshot === previous.snapshot
          && !item.manifest.snapshots.slice(1).some(r => r.contentHash === digest(bytes))
          && canMergeAuto(group, owner(context.session), context.targetPath, context.now) && !this.protected(previous, operation(context))
        const keep = new Set(previous ? [previous.snapshot] : [])
        await this.room(all, item, bytes.length, keep, merge ? 0 : 1)
        const startedAt = merge ? group!.startedAt : context.now
        const record: HistoryRecord = { ...await this.store.content(item.id, bytes, 'bin', context.now), capturedToken: token, source: context.source, groupStartedAt: context.source === 'auto' ? new Date(startedAt).toISOString() : null, sealed: context.source !== 'auto' }
        if (merge) { item.manifest.snapshots.shift(); item.manifest.retired.push(previous!) }
        else if (previous?.source === 'auto') previous.sealed = true
        item.manifest.snapshots.unshift(record); await this.publish(item)
        if (context.source === 'auto') this.groups.set(context.session, { startedAt, owner: owner(context.session), path: context.targetPath, sealed: false, snapshot: record.snapshot })
        else this.groups.delete(context.session)
        await this.cleanup(item)
        return { state: 'recorded', generation: item.manifest.generation, error: null }
      } catch { return { state: 'failed', generation, error: historyError() } }
    })
  }
  async list(session: DocumentSession): Promise<HistoryListing> {
    return this.store.serial(async () => {
      const all = await this.all(); await this.maintain(all, Date.now())
      const item = all.find(i => i.manifest.canonicalPath === session.path)
      return { generation: item?.manifest.generation ?? 0, entries: (item?.manifest.snapshots ?? []).map(r => this.entry(r)) }
    })
  }
  private entry(r: HistoryRecord): HistoryEntry { return { id: r.snapshot.slice(0, -4), savedAt: r.createdAt, byteLength: r.byteLength, source: r.source, sealed: r.sealed } }
  async read(session: DocumentSession, id: string): Promise<Buffer> {
    return this.store.serial(async () => {
      const item = (await this.all()).find(i => i.manifest.canonicalPath === session.path); const record = item?.manifest.snapshots.find(r => r.snapshot === `${id}.bin`)
      if (!item || !record) fail('INVALID_REQUEST', copy.historyMismatch)
      return this.store.verified(item.id, record)
    })
  }
  inspect(session: DocumentSession, id: string): Promise<HistorySnapshot> {
    const path = session.path
    return this.store.serial(async () => {
      const item = (await this.all()).find(i => i.manifest.canonicalPath === path); const record = item?.manifest.snapshots.find(r => r.snapshot === `${id}.bin`)
      if (!item || !record) fail('INVALID_REQUEST', copy.historyMismatch)
      const bytes = await this.store.verified(item.id, record)
      if (session.path !== path) fail('STALE_SESSION', copy.staleSession)
      const decoded = decodeUtf8(bytes)
      return { ...this.entry(record), contentHash: record.contentHash, text: decoded.text, format: decoded.kind === 'editable' ? decoded.format : null, restorable: decoded.kind === 'editable' && bytes.length <= EDITABLE_DOCUMENT_MAX_BYTES }
    })
  }
  clear(): Promise<void> {
    if (this.restores || this.clearing || this.leases.size) return Promise.reject(new FileFailure({ code: 'FILE_BUSY', message: copy.processingWait, retryable: true }))
    return this.clearConfirmed(async () => true).then(() => {})
  }
  private clearStorage(): Promise<void> { return this.store.serial(async () => { for (const item of await this.all()) await this.retire(item, [...item.manifest.snapshots]) }) }
}
