import { copy } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import type { AppError, AppEvent, ContentSnapshot, CurrentState, Result, SaveReceipt, SaveRequest, SessionRef } from '../../shared/contracts'
import { SaveCoordinator, saveError, validSnapshotText } from './save-coordinator'
import type { DocumentRegistry, DocumentSession } from './registry'
import { readDocument } from './reader'
import type { RecoveryStore } from './recovery-store'

const invalid: Result<void> = { status: 'error', error: { code: 'INVALID_REQUEST', message: copy.invalidClose, retryable: true } }
export type CloseChoice = 'save' | 'save-as' | 'discard' | 'cancel'
interface Pending { requestId: string; session: DocumentSession; interactive: boolean; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout>; responding: boolean }
/** One ref-specific snapshot challenge. Release belongs to WorkspaceCloseCoordinator. */
export class CloseCoordinator {
  private untitled?: { choose: (name: string) => Promise<'save' | 'discard' | 'cancel'>; save: (request: SaveRequest, ownerId: number) => Promise<Result<SaveReceipt>> }
  configureUntitled(handlers: NonNullable<CloseCoordinator['untitled']>): void { this.untitled = handlers }
  private pending: Pending | null = null
  result: Result<void> = { status: 'cancelled' }
  action: 'save-as' | null = null
  confirmedSnapshot: ContentSnapshot | null = null
  discarded = false
  constructor(private readonly registry: DocumentRegistry, private readonly send: (event: AppEvent) => void, private readonly choose: (name: string, error: AppError, canSaveAs: boolean, canRetry: boolean) => Promise<CloseChoice>, private readonly saves: SaveCoordinator, private readonly recovery?: Pick<RecoveryStore, 'discardSession'>, private readonly confirmDiscard: (name: string) => Promise<boolean> = async () => false, private readonly confirmHistoryLoss: (name: string) => Promise<boolean> = async () => false) {}
  get requestId(): string | null { return this.pending?.requestId ?? null }
  get active(): boolean { return this.pending !== null }
  prepare(ref: SessionRef | undefined = this.registry.current?.document, interactive = true): Promise<boolean> {
    if (this.active) return Promise.resolve(false)
    const session = ref && this.registry.list(this.registry.current?.ownerId ?? -1).find(session => session.document.docId === ref.docId && session.document.epoch === ref.epoch)
    if (!session) return Promise.resolve(!ref)
    this.result = { status: 'cancelled' }; this.action = null; this.discarded = false; this.confirmedSnapshot = null
    return new Promise(resolve => {
      const requestId = randomUUID()
      const timer = setTimeout(() => this.finish(copy.closeTimeout), 5000)
      this.pending = { requestId, session, interactive, resolve, timer, responding: false }
      this.send({ type: 'prepare-close', requestId, ref: { docId: session.document.docId, epoch: session.document.epoch } })
    })
  }
  async complete(requestId: string, state: CurrentState): Promise<Result<void>> {
    const pending = this.pending
    if (!pending || pending.requestId !== requestId || pending.responding) return invalid
    const session = pending.session; const document = session.document; const snapshot = state.snapshot
    const previous = { ...(session.latestSnapshot ?? document) }
    const validIdentity = state.ref.docId === document.docId && state.ref.epoch === document.epoch
    const validSnapshot = snapshot && snapshot.docId === document.docId && snapshot.epoch === document.epoch && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= previous.revision && (snapshot.revision !== previous.revision || snapshot.text === previous.text) && document.format && validSnapshotText(snapshot, document.format)
    pending.responding = true; clearTimeout(pending.timer)
    const finish = (result: Result<void>): Result<void> => { if (this.pending === pending) { this.result = result; pending.resolve(result.status === 'ok') }; return result }
    if (!this.registry.has(session) || !validIdentity || (document.readOnlyReason ? snapshot !== null : !validSnapshot)) return finish(invalid)
    this.confirmedSnapshot = snapshot ? { ...snapshot } : null
    if (snapshot) session.latestSnapshot = { ...snapshot }
    const current = () => this.pending === pending && this.registry.has(session)
    try {
      await this.saves.settle(session)
      if (!current()) return invalid
      for (;;) {
        if (!document.displayPath && !document.readOnlyReason) {
          if (snapshot!.text === '') return finish({ status: 'ok', value: undefined })
          if (!pending.interactive) { this.action = 'save-as'; return finish({ status: 'cancelled' }) }
          const choice = await this.untitled?.choose(document.displayName) ?? 'cancel'
          if (!current()) return invalid
          if (choice === 'save' && this.untitled) {
            const saved = await this.untitled.save({ requestId: randomUUID(), snapshot: { ...snapshot! }, expectedDiskToken: null, trigger: 'close' }, session.ownerId)
            if (!current()) return invalid
            if (saved.status !== 'ok') return finish(saved)
            this.send({ type: 'save-receipt', receipt: { ...saved.value, requestId } })
            if (session.historyAttention && !await this.confirmHistoryLoss(document.displayName)) return finish({ status: 'cancelled' })
            return current() ? finish({ status: 'ok', value: undefined }) : invalid
          }
          if (choice === 'discard' && await this.confirmDiscard(document.displayName)) {
            if (!current()) return invalid
            if (!this.recovery) return finish({ status: 'error', error: { code: 'RECOVERY_FAILED', message: copy.discardUnconfirmed, retryable: true } })
            await this.recovery.discardSession(session, snapshot!)
            if (!current()) return invalid
            this.discarded = true
            return finish({ status: 'ok', value: undefined })
          }
          return finish({ status: 'cancelled' })
        }
        if ((!session.diskStatus || session.diskStatus === 'current') && (document.readOnlyReason || snapshot!.text === document.text)) {
          try {
            const candidate = await readDocument(session.path)
            if (candidate.path !== session.path || candidate.document.diskToken !== document.diskToken) session.diskStatus = 'changed'
          } catch (error) { session.diskStatus = saveError(error).code === 'NOT_FOUND' ? 'missing' : 'unavailable' }
          if (!current()) return invalid
        }
        let result: Result<void>
        if (session.diskStatus && session.diskStatus !== 'current') result = { status: 'error', error: { code: 'EXTERNAL_CHANGE', message: copy.closeExternalChange, retryable: true } }
        else if (session.recoveryPending) result = { status: 'error', error: { code: 'RECOVERY_FAILED', message: copy.closeRecoveryPending, retryable: true } }
        else if (document.readOnlyReason) result = { status: 'ok', value: undefined }
        else if (!document.displayPath) { this.action = 'save-as'; return finish({ status: 'cancelled' }) }
        else {
          const saved = await this.saves.save({ requestId: randomUUID(), snapshot: { docId: document.docId, epoch: document.epoch, revision: snapshot!.revision, text: snapshot!.text }, expectedDiskToken: document.diskToken, trigger: 'close' }, session.ownerId)
          if (!current()) return invalid
          if (saved.status === 'ok') {
            // Renderer request order is the close challenge identity, not the internal retry id.
            this.send({ type: 'save-receipt', receipt: { ...saved.value, requestId } })
            result = { status: 'ok', value: undefined }
          } else result = saved
        }
        if (result.status === 'ok' && session.historyAttention) {
          const allow = await this.confirmHistoryLoss(document.displayName)
          if (!current()) return invalid
          return finish(allow ? result : { status: 'cancelled' })
        }
        if (result.status !== 'error' || !pending.interactive) return finish(result)
        const canSaveAs = !document.readOnlyReason || ['link', 'permission'].includes(document.readOnlyReason)
        const choice = await this.choose(document.displayName, result.error, canSaveAs, !document.readOnlyReason && !session.recoveryPending && (!session.diskStatus || session.diskStatus === 'current'))
        if (!current()) return invalid
        if (choice === 'save') continue
        if (choice === 'save-as' && canSaveAs) this.action = 'save-as'
        if (choice === 'discard' && await this.confirmDiscard(document.displayName)) {
          if (!current()) return invalid
          const confirmed = snapshot ?? previous; const latest = session.latestSnapshot
          if (latest && (latest.revision !== confirmed.revision || latest.text !== confirmed.text)) return finish(invalid)
          this.confirmedSnapshot = { docId: document.docId, epoch: document.epoch, revision: confirmed.revision, text: confirmed.text }
          if (!this.recovery) return finish({ status: 'error', error: { code: 'RECOVERY_FAILED', message: copy.discardUnconfirmed, retryable: true } })
          await this.recovery.discardSession(session, this.confirmedSnapshot)
          if (!current()) return invalid
          this.discarded = true; return finish({ status: 'ok', value: undefined })
        }
        return finish(result)
      }
    } catch (error) { return finish({ status: 'error', error: saveError(error) }) }
  }
  finish(message: string | null = null): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null; this.confirmedSnapshot = null; clearTimeout(pending.timer)
    if (message) this.result = { status: 'error', error: { code: 'FILE_BUSY', message, retryable: true } }
    pending.resolve(false)
    this.send({ type: 'close-finished', requestId: pending.requestId, message })
  }
}
