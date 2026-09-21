import { copy } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import type { ContentSnapshot, RecoveryEntry, TextFormat } from '../../shared/contracts'
import type { DocumentRegistry, DocumentSession } from './registry'
import { fail, FileFailure } from './reader'
import { validSnapshotText } from './save-coordinator'
import { exact, HASH, ID, RETENTION_MS, SnapshotStore, timestamp, validRecord, type SnapshotOptions, type SnapshotRecord } from './snapshot-store'
interface RecoveryRecord extends SnapshotRecord { revision: number }
export interface RecoveryManifest { schemaVersion: 1; sessionId: string; originalPath: string | null; baseDiskToken: string | null; format: TextFormat; snapshots: RecoveryRecord[] }
export interface VerifiedRecovery { id: string; manifest: RecoveryManifest; text: string; revision: number }
export interface RecoveryOptions extends SnapshotOptions { confirmEviction?: (count: number) => Promise<boolean>; didEvict?: (count: number) => void }
export class RecoveryStore {
  private readonly store: SnapshotStore
  private readonly associations = new WeakMap<DocumentSession, string>()
  private readonly owners = new Map<string, WeakRef<DocumentSession>>()
  constructor(root: string, private readonly registry: DocumentRegistry, private readonly options: RecoveryOptions = {}) { this.store = new SnapshotStore(root, options) }
  private active(id: string): boolean { return this.activeSession(id) !== undefined }
  private async manifest(id: string): Promise<RecoveryManifest> {
    const value = await this.store.json(id)
    if (!exact(value, ['schemaVersion', 'sessionId', 'originalPath', 'baseDiskToken', 'format', 'snapshots']) || value.schemaVersion !== 1 || value.sessionId !== id || !(value.originalPath === null || typeof value.originalPath === 'string' && isAbsolute(value.originalPath)) || !(value.baseDiskToken === null || typeof value.baseDiskToken === 'string' && HASH.test(value.baseDiskToken)) || !exact(value.format, ['encoding', 'bom', 'eol']) || value.format.encoding !== 'utf-8' || typeof value.format.bom !== 'boolean' || !['lf', 'crlf'].includes(value.format.eol as string) || !Array.isArray(value.snapshots) || value.snapshots.length > 2 || !value.snapshots.every(r => exact(r, ['snapshot', 'contentHash', 'byteLength', 'createdAt', 'revision']) && validRecord(r, 'txt') && Number.isSafeInteger(r.revision) && (r.revision as number) >= 0 && r.byteLength <= 2 * 1024 * 1024)) fail('CORRUPT_DATA', copy.corruptRecoveryIndex)
    const manifest = value as unknown as RecoveryManifest
    if (manifest.snapshots.length === 2 && (manifest.snapshots[0]!.revision <= manifest.snapshots[1]!.revision || manifest.snapshots[0]!.snapshot === manifest.snapshots[1]!.snapshot)) fail('CORRUPT_DATA', copy.invalidRecoveryOrder)
    return manifest
  }
  private async discarded(id: string): Promise<boolean> {
    try { const value = await this.store.json(id, 'discarded.json'); if (!exact(value, ['schemaVersion', 'sessionId', 'discardedAt']) || value.schemaVersion !== 1 || value.sessionId !== id || !timestamp(value.discardedAt)) fail('CORRUPT_DATA', copy.corruptDiscardMarker); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async all(): Promise<{ id: string; manifest: RecoveryManifest }[]> {
    const result = []
    for (const id of await this.store.ids()) { if (await this.discarded(id)) { await this.reclaimDiscarded(id); continue; } try { result.push({ id, manifest: await this.manifest(id) }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    return result
  }
  async list(): Promise<RecoveryEntry[]> {
    return this.store.serial(async () => {
      this.pruneOwners()
      const entries: RecoveryEntry[] = []
      for (const id of await this.store.ids()) {
        try {
          if (await this.discarded(id)) { await this.reclaimDiscarded(id); continue }
          const manifest = await this.manifest(id); const latest = manifest.snapshots[0]; if (!latest) continue
          if (!this.active(id) && Date.now() - Date.parse(latest.createdAt) > RETENTION_MS) { await this.markDiscarded(id); continue }
          let available = true; try { const verified = await this.load(id); if (!manifest.originalPath && verified.text === '') continue } catch { available = false }
          entries.push({ id, displayName: manifest.originalPath ? basename(manifest.originalPath) : copy.untitled, savedAt: latest.createdAt, available })
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') entries.push({ id, displayName: copy.unreadableRecovery, savedAt: '', available: false }) }
      }
      return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    })
  }
  async load(id: string): Promise<VerifiedRecovery> {
    if (!ID.test(id)) fail('INVALID_REQUEST', copy.invalidRecoveryId)
    if (await this.discarded(id)) fail('INVALID_REQUEST', copy.alreadyDiscarded)
    const manifest = await this.manifest(id); const latest = manifest.snapshots[0]; if (!latest) fail('INVALID_REQUEST', copy.noRecoveryContent)
    const bytes = await this.store.verified(id, latest); const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes) || !validSnapshotText({ docId: id, epoch: id, revision: latest.revision, text }, manifest.format)) fail('CORRUPT_DATA', copy.invalidRecoveryContent)
    return { id, manifest, text, revision: latest.revision }
  }
  async inspect(id: string): Promise<string> { return this.store.serial(async () => (await this.load(id)).text) }
  checkpoint(session: DocumentSession, snapshot: ContentSnapshot): Promise<{ revision: number; savedAt: string }> {
    const captured = { ...snapshot }
    return this.store.serial(async () => {
      try {
        if (!this.registry.has(session) || captured.docId !== session.document.docId || captured.epoch !== session.document.epoch) fail('STALE_SESSION', copy.staleRecoverySession)
        const doc = session.document; const previous = session.latestSnapshot ?? doc
        if (doc.readOnlyReason || !doc.format || !Number.isSafeInteger(captured.revision) || captured.revision < previous.revision || captured.revision === previous.revision && captured.text !== previous.text || !validSnapshotText(captured, doc.format)) fail('STALE_REVISION', copy.staleRecoverySnapshot)
        let id = this.associations.get(session)
        if (id && await this.discarded(id)) fail('RECOVERY_FAILED', copy.discardedRecoverySession)
        session.latestSnapshot = captured
        if (session.recoveryPending && captured.revision > (session.recoveryRevision ?? doc.revision)) session.recoveryPending = false
        const all = await this.all(); const existing = all.find(item => item.id === id)
        const latest = existing?.manifest.snapshots[0]
        if (latest && latest.revision > captured.revision) fail('STALE_REVISION', copy.staleRecoveryRevision)
        if (latest?.revision === captured.revision) { const bytes = await this.store.verified(id!, latest); if (bytes.toString('utf8') !== captured.text) fail('STALE_REVISION', copy.inconsistentRecovery); return { revision: latest.revision, savedAt: latest.createdAt } }
        if (!doc.recovered && captured.text === doc.text && (doc.displayPath || !id)) fail('RECOVERY_FAILED', copy.noRecoveryNeeded)
        const now = Date.now(); const bytes = Buffer.from(captured.text, 'utf8')
        const projected = (await this.store.contentBytes()) + bytes.length
        let total = projected; let count = all.filter(item => item.manifest.snapshots.length).length + (existing?.manifest.snapshots.length ? 0 : 1)
        const evictions: { id: string; manifest: RecoveryManifest }[] = []
        const capacityReached = total > (this.store.options.maxBytes ?? 100 * 1024 * 1024) || count > 20
        for (const item of all.sort((a, b) => (a.manifest.snapshots[0]?.createdAt ?? '').localeCompare(b.manifest.snapshots[0]?.createdAt ?? ''))) {
          if (item.id === id || this.active(item.id)) continue
          const expired = now - Date.parse(item.manifest.snapshots[0]?.createdAt ?? new Date(now).toISOString()) > RETENTION_MS
          if (!expired && total <= (this.store.options.maxBytes ?? 100 * 1024 * 1024) && count <= 20) continue
          evictions.push(item); total -= item.manifest.snapshots.reduce((sum, r) => sum + r.byteLength, 0); if (item.manifest.snapshots.length) count--
        }
        if (count > 20 || total > (this.store.options.maxBytes ?? 100 * 1024 * 1024)) fail('RECOVERY_FAILED', copy.recoveryCapacity)
        if (capacityReached && evictions.length && this.options.confirmEviction && !await this.options.confirmEviction(evictions.length)) fail('RECOVERY_FAILED', copy.cleanupCancelled)
        let cleaned = 0
        try { for (const item of evictions) { await this.markDiscarded(item.id); cleaned++ } } finally { if (cleaned) this.options.didEvict?.(cleaned) }
        // Count physical bytes after best-effort eviction, not requested deletion sizes.
        if (await this.store.contentBytes() + bytes.length > (this.store.options.maxBytes ?? 100 * 1024 * 1024)) fail('RECOVERY_FAILED', copy.recoveryCapacity)
        if (!id) { id = randomUUID(); await this.store.create(id); this.adopt(session, id) }
        if (latest) await this.load(id)
        const record = { ...await this.store.content(id, bytes, 'txt', now), revision: captured.revision }
        const manifest: RecoveryManifest = { schemaVersion: 1, sessionId: id, originalPath: doc.displayPath ? session.path : null, baseDiskToken: doc.diskToken, format: { ...doc.format }, snapshots: [record, ...(existing?.manifest.snapshots.slice(0, 1) ?? [])] }
        await this.store.publish(id, manifest)
        // Publication is the acknowledgement boundary. Unneeded content cleanup is maintenance only.
        await this.store.removeContent(id, existing?.manifest.snapshots.slice(1) ?? []).catch(() => {})
        return { revision: record.revision, savedAt: record.createdAt }
      } catch (error) { if (error instanceof FileFailure && ['STALE_SESSION', 'STALE_REVISION', 'CORRUPT_DATA'].includes(error.appError.code)) throw error; fail('RECOVERY_FAILED', copy.recoveryWriteFailed) }
    })
  }
  afterSave(session: DocumentSession, revision: number): Promise<void> {
    return this.store.serial(async () => {
      const id = this.associations.get(session); if (!id || await this.discarded(id)) return
      const manifest = await this.manifest(id); const keep = manifest.snapshots.filter(r => r.revision > revision)
      await this.store.publish(id, { ...manifest, originalPath: session.document.displayPath ? session.path : null, baseDiskToken: session.document.diskToken, snapshots: keep })
      await this.store.removeContent(id, manifest.snapshots.filter(r => !keep.includes(r)))
    })
  }
  /** Task6: await durable marker before releasing a session; never discard by path. */
  discardSession(session: DocumentSession, expectedSnapshot?: ContentSnapshot): Promise<void> {
    const expected = expectedSnapshot ? { ...expectedSnapshot } : undefined
    return this.store.serial(async () => {
      if (expected) {
        const latest = session.latestSnapshot ?? session.document
        if (!this.registry.has(session) || expected.docId !== session.document.docId || expected.epoch !== session.document.epoch || expected.revision !== latest.revision || expected.text !== latest.text) fail('STALE_REVISION', copy.changedAfterDiscard)
      }
      const id = this.associations.get(session); if (id) await this.markDiscarded(id)
    })
  }
  private async reclaimDiscarded(id: string): Promise<void> {
    // The valid marker and manifest together authorize only these exact records.
    // Keep the marker permanently; missing/corrupt records must not block later ones.
    let manifest: RecoveryManifest
    try { manifest = await this.manifest(id) } catch { return }
    for (const record of manifest.snapshots) await this.store.removeContent(id, [record]).catch(() => {})
  }
  private async markDiscarded(id: string): Promise<void> {
    if (await this.discarded(id)) { await this.reclaimDiscarded(id); return }
    const manifest = await this.manifest(id)
    for (const record of manifest.snapshots) await this.store.verified(id, record)
    await this.store.publish(id, { schemaVersion: 1, sessionId: id, discardedAt: new Date().toISOString() }, true)
    await this.reclaimDiscarded(id)
  }
  discard(id: string): Promise<void> { return this.store.serial(async () => { if (this.active(id)) fail('FILE_BUSY', copy.activeRecovery); await this.markDiscarded(id) }) }
  clear(): Promise<void> { return this.store.serial(async () => { for (const item of await this.all()) if (!this.active(item.id)) await this.markDiscarded(item.id) }) }
  withVerified<T>(id: string, operation: (recovery: VerifiedRecovery) => Promise<T>): Promise<T> { return this.store.serial(async () => operation(await this.load(id))) }
  activeSession(id: string): DocumentSession | undefined { const session = this.owners.get(id)?.deref(); if (session && this.registry.has(session)) return session; this.owners.delete(id); return undefined }
  private pruneOwners(): void { for (const id of this.owners.keys()) this.activeSession(id) }
  adopt(session: DocumentSession, id: string): void { this.pruneOwners(); this.associations.set(session, id); this.owners.set(id, new WeakRef(session)) }

}
