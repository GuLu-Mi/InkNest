import { expect, it } from 'vitest'
import { undo } from '@codemirror/commands'
import { WorkspaceModel } from '../../src/renderer/src/documents/workspace'
import type { OpenDocument } from '../../src/shared/contracts'
const a: OpenDocument = { docId: 'a', epoch: 'a1', displayName: 'a.md', displayPath: '/a.md', text: '# A', revision: 0,
  format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'da', readOnlyReason: null, recovered: false, readingPosition: null }
const b: OpenDocument = { ...a, docId: 'b', epoch: 'b1', displayName: 'b.md', displayPath: '/b.md', text: '# B', diskToken: 'db' }
it('keeps A text, history, selection and reading position independent of B and duplicate opens', () => {
  const workspace = new WorkspaceModel()
  workspace.install(a)
  workspace.getSession(a)!.dispatch({ changes: { from: 3, insert: ' changed' }, selection: { anchor: 2 } })
  workspace.setView(a, { mode: 'edit', reading: { top: 320, ratio: 0.4, revision: 1 }, editorTop: 180 })
  workspace.install(b); workspace.activate(a); workspace.install({ ...a })
  const session = workspace.getSession(a)!
  expect(session.snapshot().text).toBe('# A changed')
  expect(workspace.getView(a).reading.top).toBe(320)
  expect(workspace.getView(a).editorTop).toBe(180)
  expect(session.state.selection.main.anchor).toBe(2)
  expect(workspace.getSession(b)!.snapshot().text).toBe('# B')
  expect(workspace.refs).toHaveLength(2)
  expect(undo({ state: session.state, dispatch: transaction => session.apply([transaction]) })).toBe(true)
  expect(session.snapshot().text).toBe('# A')
  expect(workspace.getView(b).mode).toBe('read')
})
it('removes only the specified epoch and cancels its subscription', () => {
  const workspace = new WorkspaceModel(); workspace.install(a); workspace.install(b)
  let changes = 0; workspace.subscribe(() => changes++)
  const old = workspace.getSession(a)!
  workspace.remove({ ...a, epoch: 'stale' }); expect(workspace.refs).toHaveLength(2)
  workspace.remove(a); const removedAt = changes
  old.dispatch({ changes: { from: 0, insert: 'late' } })
  expect(changes).toBe(removedAt)
  expect(workspace.get(a)).toBeNull(); expect(workspace.active).toEqual({ docId: 'b', epoch: 'b1' })
  workspace.remove(b); expect(workspace.active).toBeNull()
})
it('stores readonly documents without an editable state', () => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a, readOnlyReason: 'size' })
  expect(workspace.getSession(a)).toBeNull(); expect(workspace.get(a)?.text).toBe('# A')
})
it('registers successful background opens independently from activating a view', () => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a })
  workspace.getSession(a)!.dispatch({ changes: { from: 3, insert: ' latest' } })
  workspace.register({ ...b }); workspace.register({ ...b, text: 'duplicate disk response' })
  expect(workspace.refs).toEqual([{ docId: 'a', epoch: 'a1' }, { docId: 'b', epoch: 'b1' }])
  expect(workspace.active).toEqual({ docId: 'a', epoch: 'a1' })
  expect(workspace.getSession(a)!.snapshot().text).toBe('# A latest')
  expect(workspace.getSession(b)!.snapshot().text).toBe('# B')
  workspace.activate(b); expect(workspace.active).toEqual({ docId: 'b', epoch: 'b1' })
})
it('clears only saving errors after a validated matching receipt, preserving unrelated errors', () => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a }); workspace.install({ ...b })
  const tab = workspace.getTab(a)!; const session = tab.session!
  session.dispatch({ changes: { from: 3, insert: ' latest' } })
  const snapshot = session.captureSave('close-a')
  tab.saveFailure = 'failure'; tab.saveError = 'temporary save failure'; tab.error = 'unrelated open failure'
  const receipt = { requestId: 'close-a', ref: { docId: 'a', epoch: 'a1' }, savedRevision: snapshot.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'saved', savedAt: '2026-09-16T00:00:00.000Z', displayName: 'a.md', displayPath: '/a.md' }
  expect(workspace.acceptSave({ ...receipt, ref: b }, snapshot.text)).toBe(false)
  expect(workspace.acceptSave(receipt, 'wrong text')).toBe(false)
  expect(tab.saveError).toBe('temporary save failure'); expect(tab.saveFailure).toBe('failure')
  expect(workspace.acceptSave(receipt, snapshot.text)).toBe(true)
  expect(session.dirty).toBe(false); expect(tab.saveFailure).toBeNull(); expect(tab.saveError).toBeNull()
  expect(tab.error).toBe('unrelated open failure')
  expect(workspace.active).toEqual({ docId: 'b', epoch: 'b1' })
  tab.saveFailure = 'failure'; tab.saveError = 'later failure'
  expect(workspace.acceptSave(receipt, snapshot.text)).toBe(false)
  expect(tab.saveError).toBe('later failure')
})
it.each([false, true])('keeps a newer request failure after older success (content changed: %s)', changed => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a })
  const tab = workspace.getTab(a)!; const session = tab.session!
  session.dispatch({ changes: { from: 3, insert: ' local' } })
  const first = session.captureSave('first')
  if (changed) session.dispatch({ changes: { from: 0, insert: 'newer ' } })
  const later = session.captureSave('later')
  expect(later.revision).toBe(first.revision + Number(changed))
  expect(session.captureSave('first')).toEqual(first)
  workspace.failSave(a, 'later', 'conflict', 'newer conflict')
  const receipt = { requestId: 'first', ref: a, savedRevision: first.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'first saved', savedAt: '2026-09-16T00:00:00.000Z', displayName: 'a.md', displayPath: '/a.md' }
  expect(workspace.acceptSave(receipt, first.text)).toBe(true)
  expect(tab.saveFailure).toBe('conflict'); expect(tab.saveError).toBe('newer conflict')
  expect(tab.saveOutcome?.requestId).toBe('later')
  tab.error = 'unrelated error'
  const close = session.captureSave('close')
  expect(workspace.acceptSave({ ...receipt, requestId: 'close', savedRevision: close.revision }, close.text)).toBe(true)
  expect(tab.saveFailure).toBeNull(); expect(tab.saveError).toBeNull(); expect(tab.error).toBe('unrelated error')
  expect(tab.saveOutcome?.requestId).toBe('close')
})
it('does not replace a newer successful outcome with an older delayed failure', () => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a })
  const tab = workspace.getTab(a)!; const session = tab.session!
  session.captureSave('older'); const newer = session.captureSave('newer')
  expect(workspace.acceptSave({ requestId: 'newer', ref: a, savedRevision: newer.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'saved', savedAt: '2026-09-16T00:00:00.000Z', displayName: 'a.md', displayPath: '/a.md' }, newer.text)).toBe(true)
  expect(workspace.failSave(a, 'older', 'failure', 'late failure')).toBe(false)
  expect(tab.saveError).toBeNull(); expect(tab.saveFailure).toBeNull()
})

it('readonly SaveAs snapshot promotes to editable only through a matching pending receipt, retaining state on failure', () => {
  const workspace = new WorkspaceModel(); const doc = { ...a, readOnlyReason: 'link' as const }; workspace.install(doc)
  const snapshot = workspace.captureSaveAs(doc, 'copy')!
  expect(workspace.getSession(doc)).toBeNull()
  const receipt = { requestId: 'copy', ref: { docId: doc.docId, epoch: doc.epoch }, savedRevision: 0, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'copytoken', savedAt: 'now', displayName: 'copy.md', displayPath: '/copy.md' }
  expect(workspace.acceptSave({ ...receipt, savedRevision: 2 }, snapshot.text)).toBe(false)
  expect(workspace.getSession(doc)).toBeNull(); expect(doc.readOnlyReason).toBe('link')
  workspace.failSave(doc, 'copy', 'failure', 'write failed'); workspace.finishSaveAs(doc)
  expect(workspace.getSession(doc)).toBeNull(); expect(doc.displayPath).toBe('/a.md')
  workspace.captureSaveAs(doc, 'copy2')
  expect(workspace.acceptSave({ ...receipt, requestId: 'copy2' }, snapshot.text)).toBe(true)
  workspace.finishSaveAs(doc)
  expect(workspace.getSession(doc)).not.toBeNull(); expect(doc.readOnlyReason).toBeNull()
  workspace.getSession(doc)!.setFrozen(false); workspace.getSession(doc)!.dispatch({ changes: { from: 0, insert: 'editable ' } })
  expect(workspace.getSession(doc)!.snapshot().text).toBe('editable # A')
  expect(doc.displayPath).toBe('/copy.md')
})
it('accepts only matching recovery revision without clearing a formal conflict', () => {
  const workspace = new WorkspaceModel(); workspace.install({ ...a }); const tab = workspace.getTab(a)!; const session = tab.session!
  session.dispatch({ changes: { from: 0, insert: 'new' } }); tab.saveError = 'conflict'
  expect(workspace.acceptRecovery({ ref: a, revision: 0, state: 'backed-up' })).toBe(false)
  expect(workspace.acceptRecovery({ ref: a, revision: 1, state: 'backed-up' })).toBe(true)
  expect(tab.recoveryStatus).toBe('backed-up'); expect(tab.saveError).toBe('conflict')
})
