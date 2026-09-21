import { expect, test } from 'vitest'
import { undo } from '@codemirror/commands'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import type { HistoryRestoreReceipt, HistorySnapshot, OpenDocument } from '../../src/shared/contracts'
const document: OpenDocument = { docId: 'doc', epoch: 'epoch', displayName: 'a.md', displayPath: '/a.md', text: 'A', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: '0'.repeat(64), readOnlyReason: null, recovered: false, readingPosition: null }
const target: HistorySnapshot = { id: 'historical', savedAt: '2026-09-17T00:00:00.000Z', byteLength: 1, contentHash: 'c'.repeat(64), text: 'C', format: document.format, restorable: true, source: 'manual' as const, sealed: true }
function fixture() {
  const session = new DocumentSession({ ...document }); session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); session.captureSave('old'); session.setFrozen(true)
  expect(session.captureHistoryRestore).toBeTypeOf('function'); session.captureHistoryRestore('restore', target)
  const receipt: HistoryRestoreReceipt = { kind: 'restored', requestId: 'restore', ref: { docId: 'doc', epoch: 'epoch' }, previousRevision: 1, historyId: target.id, contentHash: target.contentHash, preservedCurrent: null, restored: { requestId: 'restore', ref: { docId: 'doc', epoch: 'epoch' }, savedRevision: 2, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'c'.repeat(64), savedAt: target.savedAt, displayName: 'a.md', displayPath: '/a.md' } }
  return { session, receipt }
}
test('dedicated restore atomically notifies once, creates an isolated undo step and rejects older ordinary receipts', () => {
  const { session, receipt } = fixture(); const observations: string[] = []; session.subscribe(() => observations.push(`${session.snapshot().text}/${session.dirty}/${session.currentRevision}`))
  expect(session.acceptHistoryRestore(receipt)).toBe(true); expect(observations).toEqual(['C/false/2'])
  expect(session.acceptSave({ ...receipt.restored, requestId: 'old', savedRevision: 1 }, 'B')).toBe(false)
  expect(session.acceptHistoryRestore(receipt)).toBe(false); session.setFrozen(false)
  const back = () => undo({ state: session.state, dispatch: transaction => session.apply([transaction]) })
  expect(back()).toBe(true); expect(session.snapshot()).toMatchObject({ text: 'B', revision: 3 }); expect(session.dirty).toBe(true)
  expect(back()).toBe(true); expect(session.snapshot().text).toBe('A')
})
test.each(['epoch', 'history', 'hash', 'revision', 'nested-ref', 'nested-request', 'path', 'order'] as const)('rejects %s receipt without touching current text or undo', kind => {
  const { session, receipt } = fixture()
  if (kind === 'epoch') receipt.ref.epoch = 'other'
  if (kind === 'history') receipt.historyId = 'other'
  if (kind === 'hash') receipt.contentHash = '0'.repeat(64)
  if (kind === 'revision') receipt.restored.savedRevision = 1
  if (kind === 'nested-ref') receipt.restored.ref.epoch = 'other'
  if (kind === 'nested-request') receipt.restored.requestId = 'other'
  if (kind === 'path') receipt.restored.displayPath = '/elsewhere.md'
  if (kind === 'order') { const next = session.captureSave('newer'); session.acceptSave({ ...receipt.restored, requestId: 'newer', savedRevision: 1 }, next.text) }
  expect(session.acceptHistoryRestore(receipt)).toBe(false); expect(session.snapshot()).toMatchObject({ text: 'B', revision: 1 })
})

test('restore IPC failure accepts preserved B with its captured order and pauses uncertain autosaves', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const actions = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); session.setFrozen(true); tab.frozen = true
  expect(await actions.restoreHistory(workspace, tab, target, async request => ({ status: 'error', error: { code: 'EXTERNAL_CHANGE', message: 'injected', retryable: false }, diskUncertain: true, preservedCurrent: { requestId: request.requestId, ref: request.snapshot, savedRevision: 1, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'b'.repeat(64), savedAt: target.savedAt, displayName: 'a.md', displayPath: '/a.md' } }))).toBe(false)
  expect(session.snapshot()).toMatchObject({ text: 'B', revision: 1 }); expect(session.dirty).toBe(false); expect(session.document.diskToken).toBe('b'.repeat(64)); expect(tab.diskStatus).toBe('changed'); expect(tab.saveFailure).toBe('conflict')
  session.setFrozen(false); expect(undo({ state: session.state, dispatch: transaction => session.apply([transaction]) })).toBe(true); expect(session.snapshot().text).toBe('A')
})

test('restore request validates fixed keys, UUID, full identity and hashes', async () => {
  const { validHistoryRestoreArgs } = await import('../../src/main/ipc/validation')
  const uuid = '00000000-0000-0000-0000-000000000000'
  const request = { requestId: uuid, snapshot: { docId: uuid, epoch: uuid, text: 'B', revision: 1 }, expectedDiskToken: 'a'.repeat(64), historyId: uuid, expectedContentHash: 'c'.repeat(64) }
  expect(validHistoryRestoreArgs([request])).toBe(true)
  for (const patch of [{ force: true }, { path: '/other.md' }, { expectedContentHash: 'bad' }, { historyId: '../../elsewhere' }, { snapshot: { ...request.snapshot, epoch: 'old' } }, { snapshot: { ...request.snapshot, text: null } }]) expect(validHistoryRestoreArgs([{ ...request, ...patch }])).toBe(false)
})

test('lost restore reply preserves B and blocks automatic saving through real workspace eligibility', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const { restoreHistory } = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); session.setFrozen(true); tab.frozen = true
  expect(await restoreHistory(workspace, tab, target, async () => { throw new Error('lost IPC reply') })).toBe(false)
  expect(session.snapshot().text).toBe('B'); expect(session.dirty).toBe(true); expect(tab.diskStatus).toBe('changed'); expect(tab.saveFailure).toBe('conflict')
})

test.each(['request', 'path'] as const)('partial preservation rejects mismatched %s rather than accepting another pending save', async kind => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const { restoreHistory } = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); session.captureSave('other-save'); session.setFrozen(true); tab.frozen = true
  await restoreHistory(workspace, tab, target, async request => ({ status: 'error', error: { code: 'HISTORY_FAILED', message: 'injected', retryable: false }, diskUncertain: false, preservedCurrent: { requestId: kind === 'request' ? 'other-save' : request.requestId, ref: request.snapshot, savedRevision: 1, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'b'.repeat(64), savedAt: target.savedAt, displayName: 'a.md', displayPath: kind === 'path' ? '/wrong.md' : '/a.md' } }))
  expect(session.snapshot().text).toBe('B'); expect(session.document.diskToken).toBe('0'.repeat(64)); expect(session.document.displayPath).toBe('/a.md'); expect(session.dirty).toBe(true)
})

test('uncertain operation retains one exact request across retry loss, refuses a second target, and releases on removal', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const actions = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); tab.frozen = true; session.setFrozen(true)
  const requests: import('../../src/shared/contracts').HistoryRestoreRequest[] = []
  const lose = async (request: import('../../src/shared/contracts').HistoryRestoreRequest): Promise<never> => { requests.push(structuredClone(request)); throw new Error('lost') }
  await actions.restoreHistory(workspace, tab, target, lose)
  session.setFrozen(false); session.dispatch({ changes: { from: 0, insert: 'blocked' } }); expect(session.snapshot().text).toBe('B')
  expect(actions.pendingHistoryRestore(workspace)).toMatchObject({ ref: { docId: 'doc', epoch: 'epoch' }, historyId: target.id })
  const other = { ...document, docId: 'other', epoch: 'other-epoch' }; workspace.install(other); const otherTab = workspace.getTab(other)!; otherTab.frozen = true; otherTab.session!.setFrozen(true)
  expect(await actions.restoreHistory(workspace, otherTab, { ...target, id: 'second' }, lose)).toBe(false)
  expect(requests).toHaveLength(1)
  for (let i = 0; i < 2; i++) expect(await actions.retryHistoryRestoreReceipt(workspace, tab, lose)).toBe(false)
  expect(requests).toHaveLength(3); expect(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0]))).toBe(true)
  workspace.remove(document); expect(actions.pendingHistoryRestore(workspace)).toBeNull(); expect(session.saveOrder(requests[0]!.requestId)).toBeUndefined(); expect(session.frozen).toBe(false)
  expect(await actions.restoreHistory(workspace, otherTab, target, async () => ({ status: 'cancelled' }))).toBe(false)
  expect(actions.pendingHistoryRestore(workspace)).toBeNull(); workspace.dispose()
})

test.each(['cancelled', 'error', 'replaced', 'disposed'] as const)('uncertain capture is released on %s without a new document revision', async outcome => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const actions = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); tab.frozen = true; session.setFrozen(true)
  let id = ''; await actions.restoreHistory(workspace, tab, target, async request => { id = request.requestId; throw new Error('lost') })
  if (outcome === 'replaced') workspace.replace(document, { ...document, epoch: 'replacement' })
  else if (outcome === 'disposed') workspace.dispose()
  else await actions.retryHistoryRestoreReceipt(workspace, tab, async () => outcome === 'cancelled' ? { status: 'cancelled' } : { status: 'error', error: { code: 'HISTORY_FAILED', message: 'failed before write', retryable: true }, preservedCurrent: null, diskUncertain: false })
  expect(actions.pendingHistoryRestore(workspace)).toBeNull(); expect(session.saveOrder(id)).toBeUndefined(); expect(session.currentRevision).toBe(1); expect(session.snapshot().text).toBe('B')
  session.setFrozen(false); expect(session.frozen).toBe(false)
  if (outcome === 'cancelled') { expect(tab.diskStatus).toBe('current'); expect(tab.saveFailure).toBeNull() }
  workspace.dispose()
})

test('synchronous transport failures remain retryable and concurrent retries share one invocation', async () => {
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const actions = await import('../../src/renderer/src/documents/history-actions')
  const workspace = new WorkspaceModel(); workspace.install({ ...document }); const tab = workspace.getTab(document)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, to: 1, insert: 'B' } }); tab.frozen = true; session.setFrozen(true)
  let attempts = 0
  await actions.restoreHistory(workspace, tab, target, () => { attempts++; throw new Error('sync transport failure') })
  let complete!: (result: import('../../src/shared/contracts').HistoryRestoreResult) => void
  const invoke = () => { attempts++; return new Promise<import('../../src/shared/contracts').HistoryRestoreResult>(resolve => { complete = resolve }) }
  const first = actions.retryHistoryRestoreReceipt(workspace, tab, invoke)
  const second = actions.retryHistoryRestoreReceipt(workspace, tab, invoke)
  await Promise.resolve()
  expect(attempts).toBe(2); expect(first).toBe(second)
  complete({ status: 'cancelled' }); expect(await first).toBe(false); expect(actions.pendingHistoryRestore(workspace)).toBeNull(); workspace.dispose()
})

test('accepted restore delivers its exact isolated transaction to mounted views before general observers and unsubscribes', () => {
  const { session, receipt } = fixture()
  let mountedState = session.state
  const stop = session.subscribeHistoryRestore(transaction => {
    expect(transaction.startState).toBe(mountedState)
    mountedState = transaction.state
    expect(mountedState).toBe(session.state)
  })
  const stopGeneral = session.subscribe(() => expect(mountedState).toBe(session.state))
  expect(session.acceptHistoryRestore(receipt)).toBe(true)
  expect(mountedState.doc.toString()).toBe('C')
  stop(); stopGeneral()
  // A detached view must not consume later restore transactions from this session.
  const detached = mountedState
  const nextTarget = { ...target, id: 'next', text: 'D', contentHash: 'd'.repeat(64) }
  session.captureHistoryRestore('next', nextTarget)
  const next = { ...receipt, requestId: 'next', previousRevision: 2, historyId: 'next', contentHash: nextTarget.contentHash, restored: { ...receipt.restored, requestId: 'next', savedRevision: 3 } }
  expect(session.acceptHistoryRestore(next)).toBe(true)
  expect(session.snapshot().text).toBe('D'); expect(mountedState).toBe(detached); expect(mountedState.doc.toString()).toBe('C')
})
