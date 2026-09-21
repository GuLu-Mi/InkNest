import { copy } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import type { AppEvent, ContentSnapshot, CurrentState, Result, SessionRef } from '../../shared/contracts'
import type { CloseCoordinator } from './close-coordinator'
import type { RecoveryStore } from './recovery-store'
import type { DocumentRegistry, DocumentSession } from './registry'
import { fail } from './reader'
import { saveError, type SaveCoordinator } from './save-coordinator'
const refOf = (session: DocumentSession): SessionRef => ({ docId: session.document.docId, epoch: session.document.epoch })
const key = (ref: SessionRef) => `${ref.docId}/${ref.epoch}`
/** Main owns the barrier: no renderer return value can authorize release. */
export class WorkspaceCloseCoordinator {
  private windowRequest: string | null = null
  private documentRequest: SessionRef | null = null
  private readonly operations = new Map<string, SessionRef | null>()
  private released = () => {}
  constructor(private readonly registry: DocumentRegistry, private readonly ownerId: number, private readonly send: (event: AppEvent) => void, private readonly close: CloseCoordinator, private readonly saves: SaveCoordinator, private readonly recovery: Pick<RecoveryStore, 'afterSave'>) {}
  get active(): boolean { return this.windowRequest !== null || this.documentRequest !== null }
  get windowActive(): boolean { return this.windowRequest !== null }
  isBlocked(ref: SessionRef): boolean { return this.windowActive || !!this.documentRequest && key(this.documentRequest) === key(ref) }
  onRelease(callback: () => void): void { this.released = callback }
  configureUntitled(handlers: Parameters<CloseCoordinator['configureUntitled']>[0]): void { this.close.configureUntitled(handlers) }
  async lifecycle<T>(ref: SessionRef, operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.isBlocked(ref)) return { status: 'cancelled' }
    const id = randomUUID(); this.operations.set(id, { docId: ref.docId, epoch: ref.epoch })
    try { return await operation() } finally { this.operations.delete(id) }
  }
  async admission<T>(operation: () => Promise<T>): Promise<T> {
    const id = randomUUID(); this.operations.set(id, null)
    try { return await operation() } finally { this.operations.delete(id) }
  }
  private locate(ref: SessionRef, requestId: string, action: 'save-as' | null = null): void {
    if (this.registry.activate(ref, this.ownerId)) this.send({ type: 'close-blocked', requestId, ref, action: action ?? 'locate' })
  }
  private release(session: DocumentSession): void {
    const ref = refOf(session)
    if (this.registry.release(ref, this.ownerId)) this.send({ type: 'document-closed', ref })
  }
  private validConfirmed(session: DocumentSession, snapshot: ContentSnapshot | null): boolean {
    const latest = session.latestSnapshot
    return this.registry.has(session) && (!latest || !!snapshot && latest.revision === snapshot.revision && latest.text === snapshot.text)
  }
  private async maintain(session: DocumentSession, snapshot: ContentSnapshot | null): Promise<void> {
    await this.saves.settle(session)
    // Keep the association usable if a later document cancels the window barrier.
    if (!this.validConfirmed(session, snapshot)) fail('STALE_REVISION', copy.changedDuringClose)
    await this.recovery.afterSave(session, snapshot?.revision ?? session.document.revision)
  }
  async closeDocument(ref: SessionRef): Promise<Result<void>> {
    if (this.active) return { status: 'cancelled' }
    const session = this.registry.get(ref, this.ownerId)
    if (!session) return { status: 'error', error: { code: 'STALE_SESSION', message: copy.staleSession, retryable: false } }
    if (this.saves.isRestoring(session)) return { status: 'cancelled' }
    if ([...this.operations.values()].some(value => value === null || key(value) === key(ref))) { if (this.registry.activate(ref, this.ownerId)) this.send({ type: 'document-activated', ref }); return { status: 'cancelled' } }
    this.documentRequest = { docId: ref.docId, epoch: ref.epoch }
    let requestId = ''; let success = false; let action: 'save-as' | null = null
    try {
      const preparing = this.close.prepare(ref); requestId = this.close.requestId!
      if (!await preparing) { action = this.close.action; return this.close.result }
      const snapshot = this.close.confirmedSnapshot
      if (!this.close.discarded) await this.maintain(session, snapshot)
      if (!this.validConfirmed(session, snapshot)) return { status: 'cancelled' }
      this.release(session); this.released(); success = true
      return { status: 'ok', value: undefined }
    } catch (error) { const mapped = saveError(error); this.send({ type: 'close-error', requestId, ref, error: mapped }); return { status: 'error', error: mapped } }
    finally { this.close.finish(); this.documentRequest = null; if (!success) this.locate(ref, requestId, action) }
  }
  async closeWindow(): Promise<boolean> {
    if (this.active) return false
    const requestId = this.windowRequest = randomUUID()
    const sessions = [...this.registry.list(this.ownerId)]
    const confirmed = new Map<DocumentSession, ContentSnapshot | null>()
    let problem: SessionRef | null = null; let action: 'save-as' | null = null; let success = false
    this.send({ type: 'workspace-freeze', requestId })
    try {
      const restoring = sessions.find(session => this.saves.isRestoring(session))
      if (restoring) { problem = refOf(restoring); return false }
      const operation = this.operations.values().next().value
      if (this.operations.size) { problem = operation ?? (sessions[0] ? refOf(sessions[0]) : null); return false }
      for (const session of sessions) {
        problem = refOf(session)
        if (this.windowRequest !== requestId || !this.registry.has(session) || !await this.close.prepare(problem, false)) { action = this.close.action; return false }
        confirmed.set(session, this.close.confirmedSnapshot)
        this.close.finish()
      }
      for (const session of sessions) { problem = refOf(session); await this.maintain(session, confirmed.get(session)!) }
      const changed = sessions.find(session => !this.validConfirmed(session, confirmed.get(session)!))
      if (changed) { problem = refOf(changed); fail('STALE_REVISION', copy.changedDuringWindowClose) }
      if (this.windowRequest !== requestId || this.registry.list(this.ownerId).length !== sessions.length) return false
      for (const session of sessions) this.release(session)
      this.released(); success = true; return true
    } catch (error) {
      if (problem) this.send({ type: 'close-error', requestId, ref: problem, error: saveError(error) })
      return false
    } finally {
      this.close.finish(); this.windowRequest = null
      this.send({ type: 'workspace-thaw', requestId })
      if (!success && problem) this.locate(problem, requestId, action)
    }
  }
  complete(requestId: string, state: CurrentState): Promise<Result<void>> { return this.close.complete(requestId, state) }
  finish(): void { this.close.finish(); const requestId = this.windowRequest; this.windowRequest = null; this.documentRequest = null; if (requestId) this.send({ type: 'workspace-thaw', requestId }) }
}
