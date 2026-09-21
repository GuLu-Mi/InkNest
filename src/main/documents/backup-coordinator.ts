import { copy } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import type { OpenDocument, Result, SessionRef } from '../../shared/contracts'
import type { DocumentRegistry } from './registry'
import type { SaveCoordinator } from './save-coordinator'
import type { RecoveryStore } from './recovery-store'
import type { HistoryStore } from './history-store'
import { fail, readDocument, safeError, type Candidate } from './reader'
import { atomicWrite } from './atomic-writer'
import { digest } from './snapshot-store'
interface BackupDialogs { choosePath(name: string): Promise<string | null>; confirm(kind: 'replace' | 'directory', name: string): Promise<boolean> }
export class BackupCoordinator {
  constructor(private readonly registry: DocumentRegistry, private readonly saves: SaveCoordinator, readonly recovery: RecoveryStore, readonly history: HistoryStore, private readonly dialogs: BackupDialogs) {}
  async restore(id: string, ownerId: number): Promise<Result<OpenDocument>> {
    try {
      for (;;) {
        // Never await registry writes while holding the recovery queue: afterSave
        // needs that queue before releasing its write reservation.
        const version = await this.registry.waitForWrites()
        const result = await this.recovery.withVerified<Result<OpenDocument> | null>(id, async recovery => {
          if (!this.registry.isWriteVersionCurrent(version)) return null
          const active = this.recovery.activeSession(id)
          if (active) { this.registry.activate(active.document, ownerId); fail('TARGET_OPEN', copy.recoveryAlreadyOpen) }
          let candidate: Candidate | null = null
          let diskStatus: 'current' | 'missing' | 'changed' | 'unavailable' = 'missing'
          if (recovery.manifest.originalPath) {
            try { candidate = await readDocument(recovery.manifest.originalPath); diskStatus = candidate.document.diskToken === recovery.manifest.baseDiskToken ? 'current' : 'changed' } catch (error) { diskStatus = safeError(error).code === 'NOT_FOUND' ? 'missing' : 'unavailable' }
          }
          // Reading yields. Revalidate admission, then check current canonical
          // path/inode ownership and register synchronously with no intervening await.
          if (!this.registry.isWriteVersionCurrent(version)) return null
          const document = this.registry.registerRecovery(recovery, ownerId, candidate, diskStatus, version)
          this.recovery.adopt(this.registry.get(document, ownerId)!, id)
          return { status: 'ok', value: document }
        })
        if (result) return result
      }
    } catch (error) { return { status: 'error', error: safeError(error) } }
  }
  async exportHistory(ref: SessionRef, id: string, ownerId: number): Promise<Result<void>> {
    let selectedProtection: Awaited<ReturnType<HistoryStore['pin']>> | null = null
    try {
      const session = this.registry.get(ref, ownerId); if (!session) fail('STALE_SESSION', copy.staleSession)
      selectedProtection = await this.history.pin(session, id)
      const bytes = await this.history.read(session, id)
      const entry = (await this.history.list(session)).entries.find(entry => entry.id === id)
      if (!entry) fail('NOT_FOUND', copy.invalidBackupId)
      return await this.saves.barrier(session, async () => {
        const selected = await this.dialogs.choosePath(copy.historyFilename(session.document.displayName, entry.savedAt)); if (!selected) return { status: 'cancelled' }
        if (!['.md', '.markdown'].includes(extname(selected).toLowerCase())) fail('UNSUPPORTED_TYPE', copy.markdownName)
        const target = join(await realpath(dirname(selected)), basename(selected))
        return this.registry.serializeWrite(session, async () => {
          const readTarget = async () => { try { await lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }; return readDocument(target) }
          const old = await readTarget()
          const checkOpened = (candidate: Candidate | null) => { if (target === session.path || (candidate ? this.registry.findCandidate(candidate, ownerId) : this.registry.findPath(target))) fail('TARGET_OPEN', copy.historyTargetOpen) }
          checkOpened(old)
          if (dirname(target) !== dirname(session.path) && !await this.dialogs.confirm('directory', basename(target))) return { status: 'cancelled' }
          if (old && (old.document.readOnlyReason || old.path !== target)) fail('READ_ONLY', copy.unsafeTarget)
          if (old && !await this.dialogs.confirm('replace', basename(target))) return { status: 'cancelled' }
          const check = async () => { if (!this.registry.has(session)) fail('STALE_SESSION', copy.staleSession); if (await realpath(dirname(target)) !== dirname(target)) fail('EXTERNAL_CHANGE', copy.targetDirectoryChanged); const current = await readTarget(); checkOpened(current); if (old ? !current || current.document.diskToken !== old.document.diskToken || current.document.readOnlyReason || current.path !== target : current !== null) fail('EXTERNAL_CHANGE', copy.exportTargetChanged) }
          await check()
          const protection = old ? await this.history.protectBeforeWrite({ session, targetPath: target, requestId: randomUUID(), revision: session.document.revision, source: 'save-as', now: Date.now() }, old.rawBytes, old.document.diskToken!, true) : null
          try {
          const written = await atomicWrite(target, bytes, check); const saved = await readDocument(target)
          if (saved.fingerprint.sha256 !== digest(bytes) || saved.fingerprint.dev !== written.dev || saved.fingerprint.ino !== written.ino) fail('EXTERNAL_CHANGE', copy.exportChangedAfterWrite)
          return { status: 'ok', value: undefined }
          } finally { protection?.release() }
        }, target)
      })
    } catch (error) { return { status: 'error', error: safeError(error) } }
    finally { selectedProtection?.release() }
  }
}
