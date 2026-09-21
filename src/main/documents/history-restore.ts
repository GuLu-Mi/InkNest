import type { HistoryRestoreRequest, HistoryRestoreResult, SaveReceipt, SaveRequest } from '../../shared/contracts'
import { copy } from '../../shared/copy'
import { EDITABLE_DOCUMENT_MAX_BYTES } from '../../shared/limits'
import type { HistoryStore } from './history-store'
import type { DocumentRegistry, DocumentSession } from './registry'
import { fail, readDocument } from './reader'
import { saveError, validSnapshotText } from './save-coordinator'

/** Runs inside the save queue and registry target lock; never re-enters either queue. */
export async function restoreHistoryTransaction(
  registry: DocumentRegistry, session: DocumentSession, request: HistoryRestoreRequest, history: HistoryStore,
  confirm: () => Promise<boolean>, write: (request: SaveRequest, beforeWrite: () => void) => Promise<SaveReceipt>,
  invalidateChain: () => void
): Promise<HistoryRestoreResult> {
  let preservedCurrent: SaveReceipt | null = null
  let writeAttempted = false
  const path = session.path; const format = JSON.stringify(session.document.format)
  const ref = { docId: request.snapshot.docId, epoch: request.snapshot.epoch }
  const validate = async () => {
    const document = session.document; const latest = session.latestSnapshot ?? document
    if (!registry.has(session) || session.path !== path || document.epoch !== ref.epoch) fail('STALE_SESSION', copy.staleSession)
    if (document.readOnlyReason || !document.format || JSON.stringify(document.format) !== format) fail('READ_ONLY', copy.readOnlyDocument)
    if (session.recoveryPending || document.recovered || session.diskStatus && session.diskStatus !== 'current') fail('EXTERNAL_CHANGE', copy.resolveConflictFirst)
    if (latest.revision !== request.snapshot.revision || latest.text !== request.snapshot.text) fail('STALE_REVISION', copy.staleSave)
    const disk = await readDocument(path)
    if (disk.path !== path || disk.document.readOnlyReason || disk.document.diskToken !== document.diskToken) fail('EXTERNAL_CHANGE', copy.saveBaselineChanged)
  }
  let targetProtection: Awaited<ReturnType<HistoryStore['pin']>> | null = null
  try {
    await validate()
    targetProtection = await history.pin(session, request.historyId)
    const target = await history.inspect(session, request.historyId)
    if (target.contentHash !== request.expectedContentHash) fail('CORRUPT_DATA', copy.historyMismatch)
    if (!target.format || target.byteLength > EDITABLE_DOCUMENT_MAX_BYTES || !validSnapshotText({ ...request.snapshot, text: target.text }, session.document.format!)) fail('READ_ONLY', copy.readOnlyDocument)
    await validate()
    if (target.text === request.snapshot.text) return { status: 'ok', value: { kind: 'unchanged', requestId: request.requestId, ref, historyId: target.id, contentHash: target.contentHash, revision: request.snapshot.revision } }
    if (!await confirm()) return { status: 'cancelled' }
    await validate()
    const checked = await history.inspect(session, request.historyId)
    if (checked.contentHash !== target.contentHash) fail('CORRUPT_DATA', copy.historyMismatch)
    const current: SaveRequest = { requestId: request.requestId, snapshot: request.snapshot, expectedDiskToken: session.document.diskToken, trigger: 'manual' }
    if (request.snapshot.text !== session.document.text) {
      preservedCurrent = await write(current, () => { writeAttempted = true })
      if (preservedCurrent.history.state === 'failed' || preservedCurrent.history.state === 'skipped') fail('HISTORY_FAILED', copy.historySavedFailed)
    }
    await validate()
    const restored = await write({ ...current, snapshot: { ...request.snapshot, text: target.text, revision: request.snapshot.revision + 1 }, expectedDiskToken: session.document.diskToken }, () => { writeAttempted = true })
    invalidateChain()
    session.latestSnapshot = { ...request.snapshot, text: target.text, revision: restored.savedRevision }
    return { status: 'ok', value: { kind: 'restored', requestId: request.requestId, ref, previousRevision: request.snapshot.revision, historyId: target.id, contentHash: target.contentHash, preservedCurrent, restored } }
  } catch (error) {
    let diskUncertain = false
    if (writeAttempted) {
      try { const disk = await readDocument(path); diskUncertain = disk.path !== path || disk.document.diskToken !== session.document.diskToken }
      catch { diskUncertain = true }
    }
    if (diskUncertain) { session.diskStatus = 'changed'; invalidateChain() }
    const mapped = saveError(error)
    if (mapped.code === 'EXTERNAL_CHANGE') session.diskStatus = 'changed'
    return { status: 'error', error: mapped, preservedCurrent, diskUncertain }
  } finally { targetProtection?.release() }
}
