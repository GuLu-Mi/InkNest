import { copy } from '../../shared/copy'
import type { RecoveryStore } from './recovery-store'
import { randomUUID } from 'node:crypto'
import type { ConflictAction, ConflictOutcome, ContentSnapshot, CurrentState, ReconcileOutcome, Result, SaveReceipt, SaveRequest, SessionRef } from '../../shared/contracts'
import { fail, readDocument, safeError } from './reader'
import { DocumentRegistry, type DocumentSession } from './registry'
import { SaveCoordinator, saveError, validSnapshotText } from './save-coordinator'

export interface LifecycleDialogs {
  choosePath(name: string, initial?: boolean): Promise<string | null>
  confirm(kind: 'replace' | 'directory' | 'overwrite' | 'use-disk', name: string, modifiedAt?: string): Promise<boolean>
}
export class FileLifecycle {
  private readonly inspectedTokens = new WeakMap<DocumentSession, string>()
  constructor(private readonly registry: DocumentRegistry, private readonly saves: SaveCoordinator, private readonly dialogs: LifecycleDialogs, private readonly recovery?: Pick<RecoveryStore, 'discardSession'>) {}
  private capture(state: CurrentState, ownerId: number): DocumentSession {
    const session = this.registry.get(state.ref, ownerId)
    if (!session) fail('STALE_SESSION', copy.staleSession)
    this.saves.assertAvailable(session)
    const snapshot = state.snapshot; const document = session.document; const previous = session.latestSnapshot ?? document
    if (document.readOnlyReason) {
      if (snapshot !== null) fail('INVALID_REQUEST', copy.invalidReadOnlyState)
    } else {
      if (!snapshot || snapshot.docId !== document.docId || snapshot.epoch !== document.epoch || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < previous.revision || snapshot.revision === previous.revision && snapshot.text !== previous.text || !document.format || !validSnapshotText(snapshot, document.format)) fail('STALE_REVISION', copy.invalidCurrentState)
      session.latestSnapshot = { ...snapshot }
    }
    return session
  }
  async reconcileExternal(state: CurrentState, ownerId: number): Promise<Result<ReconcileOutcome>> {
    try {
      const session = this.capture(state, ownerId)
      if (!session.document.displayPath) return { status: 'ok', value: { kind: 'unchanged' } }
      return await this.saves.barrier(session, () => this.registry.serializeWrite(session, async () => {
        try {
          const candidate = await readDocument(session.path)
          // W_OK failure after a successful read is expected for an already-readonly source.
          if (candidate.document.readOnlyReason === 'permission' && session.document.readOnlyReason === null) { session.diskStatus = 'unavailable'; return { status: 'ok', value: { kind: 'conflict', diskStatus: 'unavailable' } } }
          if (candidate.path === session.path && candidate.document.diskToken === session.document.diskToken) {
            this.registry.updateFingerprint(session, candidate.fingerprint)
            // An already reported conflict is independent of a later clean save baseline.
            if (session.diskStatus === 'changed') return { status: 'ok', value: { kind: 'conflict', diskStatus: 'changed' } }
            session.diskStatus = 'current'; return { status: 'ok', value: { kind: 'unchanged' } }
          }
          if (session.recoveryPending || session.diskStatus === 'changed' || state.snapshot && state.snapshot.text !== session.document.text) {
            session.diskStatus = 'changed'; return { status: 'ok', value: { kind: 'conflict', diskStatus: 'changed' } }
          }
          await this.recovery?.discardSession(session)
          return { status: 'ok', value: { kind: 'reloaded', document: this.registry.reload(session, candidate) } }
        } catch (error) {
          const code = safeError(error).code
          session.diskStatus = code === 'NOT_FOUND' ? 'missing' : 'unavailable'
          return { status: 'ok', value: { kind: 'conflict', diskStatus: session.diskStatus } }
        }
      }), true)
    } catch (error) { return { status: 'error', error: saveError(error) } }
  }
  async saveAs(request: SaveRequest, ownerId: number): Promise<Result<SaveReceipt>> {
    const session = this.registry.get(request.snapshot, ownerId)
    let executed = false
    const result = await this.saves.saveAs(request, ownerId, () => {
      executed = true // Cached receipts do not execute the picker or resolve a new conflict.
      const document = this.registry.get(request.snapshot, ownerId)?.document
      return this.dialogs.choosePath(document?.displayPath ? document.displayName : `${document?.displayName ?? copy.untitled}.md`, !document?.displayPath)
    }, (kind, name) => this.dialogs.confirm(kind, name))
    if (result.status === 'ok' && executed && session) this.inspectedTokens.delete(session)
    return result
  }
  async resolveConflict(ref: SessionRef, action: ConflictAction, snapshot: ContentSnapshot, ownerId: number): Promise<Result<ConflictOutcome>> {
    try {
      const session = this.capture({ ref, snapshot }, ownerId)
      const request: SaveRequest = { requestId: randomUUID(), snapshot: { ...snapshot }, expectedDiskToken: session.document.diskToken, trigger: 'manual' }
      if (action === 'save-copy') {
        const result = await this.saveAs(request, ownerId)
        return result.status === 'ok' ? { status: 'ok', value: { kind: 'saved', receipt: result.value } } : result
      }
      return await this.saves.barrier(session, async () => {
        const shown = await readDocument(session.path)
        if (action === 'inspect') { this.inspectedTokens.set(session, shown.document.diskToken!); return { status: 'ok', value: { kind: 'inspection', text: shown.document.text, diskToken: shown.document.diskToken! } } }
        const inspected = this.inspectedTokens.get(session)
        if (inspected && inspected !== shown.document.diskToken) { this.inspectedTokens.delete(session); fail('EXTERNAL_CHANGE', copy.diskChangedAgain) }
        if (!await this.dialogs.confirm(action, session.document.displayName, new Date(shown.fingerprint.mtimeMs).toLocaleString())) return { status: 'cancelled' }
        if (action === 'overwrite') {
          const result = await this.saves.overwrite(session, request, shown.document.diskToken!)
          if (result.status === 'ok') this.inspectedTokens.delete(session)
          return result.status === 'ok' ? { status: 'ok', value: { kind: 'saved', receipt: result.value } } : result
        }
        return this.registry.serializeWrite(session, async () => {
          const current = await readDocument(session.path)
          if (current.path !== shown.path || current.document.diskToken !== shown.document.diskToken) fail('EXTERNAL_CHANGE', copy.diskChangedAgain)
          await this.recovery?.discardSession(session)
          const document = this.registry.reload(session, current)
          this.inspectedTokens.delete(session)
          return { status: 'ok', value: { kind: 'opened', document } }
        })
      }, action !== 'inspect')
    } catch (error) { return { status: 'error', error: saveError(error) } }
  }
}
