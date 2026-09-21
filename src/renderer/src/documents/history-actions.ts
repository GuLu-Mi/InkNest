import type { HistoryRestoreRequest, HistoryRestoreResult, HistorySnapshot, SessionRef } from '../../../shared/contracts'
import { copy } from '../../../shared/copy'
import type { DocumentSession } from './session'
import type { WorkspaceModel, TabState } from './workspace'

type Invoke = (request: HistoryRestoreRequest) => Promise<HistoryRestoreResult>
interface Operation {
  tab: TabState
  session: DocumentSession
  request: HistoryRestoreRequest
  before: Pick<TabState, 'diskStatus' | 'saveFailure' | 'saveError'>
  uncertain: boolean
  running: Promise<boolean> | null
  unsubscribe: () => void
}
// One temporary operation per workspace. Historical text remains only in the original
// session capture; this map neither creates a browsing cache nor duplicates that text.
const operations = new WeakMap<WorkspaceModel, Operation>()
export interface PendingHistoryRestore { ref: SessionRef; historyId: string; retrying: boolean }
export function pendingHistoryRestore(workspace: WorkspaceModel): PendingHistoryRestore | null {
  const operation = operations.get(workspace)
  if (!operation?.uncertain) return null
  const { docId, epoch } = operation.request.snapshot
  return { ref: { docId, epoch }, historyId: operation.request.historyId, retrying: operation.running !== null }
}
function release(workspace: WorkspaceModel, operation: Operation): void {
  if (operations.get(workspace) === operation) operations.delete(workspace)
  operation.session.abandonSave(operation.request.requestId)
  operation.unsubscribe()
}
function run(workspace: WorkspaceModel, operation: Operation, invoke: Invoke): Promise<boolean> {
  if (operation.running) return operation.running
  const { tab, session, request } = operation
  const { requestId, snapshot } = request
  const live = () => operations.get(workspace) === operation && workspace.getTab(snapshot) === tab && tab.session === session
  const execute = async (): Promise<boolean> => {
    let terminal = false
    try {
      if (!live()) return false
      // Never mutate or recapture this payload between attempts, including its old token.
      const result = await invoke({ ...request, snapshot: { ...snapshot } })
      if (!live()) return false
      if (result.status === 'cancelled') {
        terminal = true
        if (operation.uncertain) Object.assign(tab, operation.before)
        return false
      }
      if (result.status === 'ok') {
        if (result.value.kind === 'unchanged') {
          const value = result.value
          if (value.requestId !== requestId || value.ref.docId !== snapshot.docId || value.ref.epoch !== snapshot.epoch || value.revision !== snapshot.revision || value.historyId !== request.historyId || value.contentHash !== request.expectedContentHash) throw new Error('Unmatched restore receipt')
          terminal = true
          if (operation.uncertain) Object.assign(tab, operation.before)
          tab.notice = copy.restoreHistoryUnchanged
          return true
        }
        if (!workspace.acceptHistoryRestore(result.value)) throw new Error('Unmatched restore receipt')
        terminal = true
        return true
      }
      terminal = true
      // The partial receipt saves captured B without changing the editor or undo.
      const order = session.saveOrder(requestId)!
      const partial = result.preservedCurrent
      const preserved = partial && partial.requestId === requestId && partial.ref.docId === snapshot.docId && partial.ref.epoch === snapshot.epoch &&
        partial.savedRevision === snapshot.revision && partial.displayPath === tab.document.displayPath && partial.displayName === tab.document.displayName &&
        /^[a-f0-9]{64}$/u.test(partial.diskToken) && workspace.acceptSave(partial, snapshot.text)
      tab.saveOutcome = { requestId, order }
      if (operation.uncertain) tab.diskStatus = operation.before.diskStatus
      tab.saveFailure = result.diskUncertain || result.error.code === 'EXTERNAL_CHANGE' ? 'conflict' : 'failure'
      if (tab.saveFailure === 'conflict') tab.diskStatus = 'changed'
      if (result.error.code === 'NOT_FOUND') tab.diskStatus = 'missing'
      if (result.error.code === 'ACCESS_DENIED') tab.diskStatus = 'unavailable'
      tab.saveError = result.diskUncertain ? copy.restoreHistoryUncertain : preserved ? `${copy.restoreHistoryPreserved} ${result.error.message}` : result.error.message
      return false
    } catch {
      if (live()) {
        operation.uncertain = true
        session.holdHistoryRestore(requestId)
        tab.diskStatus = 'changed'; tab.saveFailure = 'conflict'; tab.saveError = copy.restoreHistoryUncertain
      }
      return false
    } finally {
      if (terminal) release(workspace, operation)
      operation.running = null
      workspace.changed()
    }
  }
  operation.running = Promise.resolve().then(execute)
  workspace.changed()
  return operation.running
}

/** Caller owns IME settlement and lifecycle freeze; uncertain results retain a separate edit hold. */
export function restoreHistory(workspace: WorkspaceModel, tab: TabState, target: HistorySnapshot, invoke: Invoke): Promise<boolean> {
  const session = tab.session
  if (operations.has(workspace) || !session || !tab.frozen || tab.diskStatus !== 'current' || tab.recoveryPending || !tab.document.displayPath) return Promise.resolve(false)
  const requestId = crypto.randomUUID()
  const snapshot = session.captureHistoryRestore(requestId, target)
  if (!snapshot) return Promise.resolve(false)
  const operation: Operation = {
    tab, session, request: { requestId, snapshot, expectedDiskToken: tab.document.diskToken, historyId: target.id, expectedContentHash: target.contentHash },
    before: { diskStatus: tab.diskStatus, saveFailure: tab.saveFailure, saveError: tab.saveError }, uncertain: false, running: null, unsubscribe: () => {}
  }
  operations.set(workspace, operation)
  operation.unsubscribe = workspace.subscribe(() => {
    if (workspace.getTab(snapshot) !== tab || tab.session !== session) { release(workspace, operation); session.setFrozen(false) }
  })
  return run(workspace, operation, invoke)
}
export function retryHistoryRestoreReceipt(workspace: WorkspaceModel, tab: TabState, invoke: Invoke): Promise<boolean> {
  const operation = operations.get(workspace)
  if (!operation?.uncertain || operation.tab !== tab || !tab.frozen || !operation.session.frozen) return Promise.resolve(false)
  return run(workspace, operation, invoke)
}
