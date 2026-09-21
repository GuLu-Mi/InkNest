import { describe, expect, it } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { DocumentSession } from '../../src/renderer/src/documents/session'
import type { OpenDocument, SaveReceipt } from '../../src/shared/contracts'

const document: OpenDocument = { docId: 'doc', epoch: 'epoch', displayName: 'test.md', displayPath: '/test.md', text: '# 原文\n', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'disk0', readOnlyReason: null, recovered: false, readingPosition: null }
function receipt(requestId: string, savedRevision: number): SaveReceipt { return { requestId, ref: document, savedRevision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: `disk${savedRevision}`, savedAt: '2026-09-16T00:00:00.000Z', displayName: 'test.md', displayPath: '/test.md' } }
function historyTarget(session: DocumentSession) { return { state: session.state, dispatch: (transaction: Parameters<DocumentSession['apply']>[0][number]) => session.apply([transaction]) } }

describe('DocumentSession', () => {
  it('derives dirty from content, preserving undo/redo and monotonic revisions', () => {
    const session = new DocumentSession({ ...document })
    session.dispatch({ changes: { from: 0, insert: '中文\n第二行\n' } })
    expect(session.dirty).toBe(true)
    expect(session.snapshot()).toMatchObject({ text: '中文\n第二行\n# 原文\n', revision: 1 })
    expect(undo(historyTarget(session))).toBe(true)
    expect(session.dirty).toBe(false)
    expect(session.snapshot().revision).toBe(2)
    expect(redo(historyTarget(session))).toBe(true)
    expect(session.dirty).toBe(true)
  })
  it('accepts only the actual submitted snapshot and leaves newer changes dirty', () => {
    const session = new DocumentSession({ ...document })
    session.dispatch({ changes: { from: 0, insert: 'A' } })
    const a = session.captureSave('A')
    session.dispatch({ changes: { from: 0, insert: 'B' } })
    session.acceptSave(receipt('A', a.revision), a.text)
    expect(session.dirty).toBe(true)
    expect(session.snapshot().text).toBe('BA# 原文\n')
    session.dispatch({ changes: { from: 0, to: 1 } })
    expect(session.dirty).toBe(false)
  })
  it('ignores stale, mismatched and duplicate receipts without rolling back a newer baseline', () => {
    const session = new DocumentSession({ ...document })
    session.dispatch({ changes: { from: 0, insert: 'A' } })
    const a = session.captureSave('A')
    session.dispatch({ changes: { from: 0, insert: 'B' } })
    const b = session.captureSave('B')
    session.acceptSave({ ...receipt('B', b.revision), ref: { docId: 'other', epoch: 'epoch' } }, b.text)
    session.acceptSave(receipt('B', b.revision), 'not the submitted text')
    expect(session.dirty).toBe(true)
    session.acceptSave(receipt('B', b.revision), b.text)
    expect(session.dirty).toBe(false)
    session.acceptSave(receipt('A', a.revision), a.text)
    session.acceptSave(receipt('B', b.revision), 'wrong')
    expect(session.dirty).toBe(false)
  })
  it('freezes mutations while keeping the latest snapshot and undo history', () => {
    const session = new DocumentSession({ ...document })
    session.dispatch({ changes: { from: 0, insert: '保留' } })
    session.frozen = true
    session.dispatch({ changes: { from: 0, insert: '禁止' } })
    undo(historyTarget(session))
    expect(session.snapshot().text).toBe('保留# 原文\n')
    session.frozen = false
    expect(undo(historyTarget(session))).toBe(true)
    expect(session.dirty).toBe(false)
  })
  it('rejects oversized serialized edits and readonly mutations', () => {
    const session = new DocumentSession({ ...document, format: { encoding: 'utf-8', bom: true, eol: 'crlf' } })
    session.dispatch({ changes: { from: 0, insert: '\n'.repeat(1024 * 1024) } })
    expect(session.dirty).toBe(false)
    expect(session.error).toContain('本次输入未应用')
    session.dispatch({ changes: { from: 0, insert: 'x'.repeat(2 * 1024 * 1024) }, filter: false })
    expect(session.dirty).toBe(false)
    const readonly = new DocumentSession({ ...document, readOnlyReason: 'encoding' })
    readonly.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(readonly.dirty).toBe(false)
  })
})
it('configures view extensions once without modifying content or revision', async () => {
  const { EditorState } = await import('@codemirror/state')
  const session = new DocumentSession({ ...document })
  session.configureView(() => EditorState.tabSize.of(8))
  session.configureView(() => { throw new Error('View extensions initialized again') })
  expect(session.state.facet(EditorState.tabSize)).toBe(8)
  expect(session.snapshot().revision).toBe(0)
  expect(session.dirty).toBe(false)
})
it('does not roll back disk identity when an earlier same-revision success arrives last', () => {
  const session = new DocumentSession({ ...document })
  session.dispatch({ changes: { from: 0, insert: 'same revision' } })
  const first = session.captureSave('first'); const second = session.captureSave('second')
  expect(first.revision).toBe(second.revision)
  expect(session.acceptSave({ ...receipt('second', second.revision), diskToken: 'newer identity' }, second.text)).toBe(true)
  expect(session.acceptSave({ ...receipt('first', first.revision), diskToken: 'older identity' }, first.text)).toBe(false)
  expect(session.document.diskToken).toBe('newer identity')
})

it('conflict receipt binds only the captured pending operation and keeps its original request order', () => {
  const session = new DocumentSession({ ...document })
  const snapshot = session.captureSave('local-operation'); const order = session.saveOrder('local-operation')
  const receipt = { requestId: 'main-operation', ref: { docId: snapshot.docId, epoch: snapshot.epoch }, savedRevision: snapshot.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'new-token', savedAt: new Date().toISOString(), displayName: 'copy.md', displayPath: '/copy.md' }
  expect(session.bindSaveReceipt('local-operation', receipt, 'wrong text')).toBe(false)
  expect(session.bindSaveReceipt('local-operation', { ...receipt, ref: { ...receipt.ref, epoch: 'old' } }, snapshot.text)).toBe(false)
  expect(session.bindSaveReceipt('local-operation', { ...receipt, ref: { ...receipt.ref, docId: 'other' } }, snapshot.text)).toBe(false)
  expect(session.bindSaveReceipt('local-operation', { ...receipt, savedRevision: snapshot.revision + 1 }, snapshot.text)).toBe(false)
  session.captureSave('main-operation')
  expect(session.bindSaveReceipt('local-operation', receipt, snapshot.text)).toBe(false)
  expect(session.saveOrder('local-operation')).toBe(order)
  session.abandonSave('main-operation')
  expect(session.bindSaveReceipt('local-operation', receipt, snapshot.text)).toBe(true)
  expect(session.saveOrder('main-operation')).toBe(order)
  expect(session.bindSaveReceipt('local-operation', receipt, snapshot.text)).toBe(false)
  expect(session.acceptSave(receipt, snapshot.text)).toBe(true)
  expect(session.document.displayPath).toBe('/copy.md')
  expect(session.bindSaveReceipt('main-operation', receipt, snapshot.text)).toBe(false)
})
