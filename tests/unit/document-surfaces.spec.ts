import { createRenderer, ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import type { HistoryRestoreRequest, HistoryRestoreResult, HistorySnapshot, OpenDocument } from '../../src/shared/contracts'
import { useWorkspace, type ActiveEditor } from '../../src/renderer/src/documents/use-workspace'
const document: OpenDocument = { docId: 'doc', epoch: 'epoch', displayName: 'a.md', displayPath: '/a.md', text: 'A', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'a'.repeat(64), readOnlyReason: null, recovered: false, readingPosition: null }
const target: HistorySnapshot = { id: 'history', text: 'A', contentHash: 'a'.repeat(64), savedAt: '2026-09-17T00:00:00Z', byteLength: 1, format: document.format, restorable: true }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
function fixture(invoke: (r: HistoryRestoreRequest) => Promise<HistoryRestoreResult>) {
  vi.stubGlobal('window', { inknest: { onEvent: () => () => {}, restoreHistory: invoke } })
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const editor = ref<ActiveEditor>({ settleComposition: async () => true, setFrozen() {} }); let ws!: ReturnType<typeof useWorkspace>
  const app = renderer.createApp({ setup() { ws = useWorkspace(editor); return () => null } }); app.mount({}); ws.workspace.install({ ...document }); cleanups.push(() => app.unmount())
  return { ws, editor }
}
const unchanged = (r: HistoryRestoreRequest): HistoryRestoreResult => ({ status: 'ok', value: { kind: 'unchanged', requestId: r.requestId, ref: { docId: r.snapshot.docId, epoch: r.snapshot.epoch }, revision: r.snapshot.revision, historyId: r.historyId, contentHash: r.expectedContentHash } })
test.each([false, true])('overlapping workspace receipt retries share exact request and successful outcome (delayed IME %s)', async delayed => {
  const requests: HistoryRestoreRequest[] = []; let complete!: (value: HistoryRestoreResult) => void
  const f = fixture(async request => { requests.push(request); if (requests.length === 1) throw Error('lost'); return new Promise(resolve => { complete = resolve }) })
  await f.ws.restoreHistory(target)
  let settled!: (value: boolean) => void
  if (delayed) f.editor.value.settleComposition = () => new Promise(resolve => { settled = resolve })
  const first = f.ws.retryHistoryRestoreReceipt(); const second = f.ws.retryHistoryRestoreReceipt()
  if (delayed) settled(true)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); complete(unchanged(requests[0]!))
  expect(await Promise.all([first, second])).toEqual([true, true]); expect(f.ws.historyRestorePending.value).toBeNull()
})
test.each([false, true])('validated unchanged restore reports notice only on source tab without revision or writes (retry %s)', async retry => {
  let calls = 0; const f = fixture(async request => { if (retry && calls++ === 0) throw Error('lost'); return unchanged(request) })
  const session = f.ws.session.value!; const state = session.state; const result = await f.ws.restoreHistory(target)
  if (retry) { f.ws.workspace.install({ ...document, docId: 'other', epoch: 'other', displayPath: '/other.md' }); expect(await f.ws.retryHistoryRestoreReceipt()).toBe(true) }
  else expect(result).toBe(true)
  expect(f.ws.workspace.getTab(document)!.notice).toBe('当前内容与此版本相同')
  if (retry) expect(f.ws.tab.value!.notice).toBe('')
  expect(session.state).toBe(state); expect(session.currentRevision).toBe(0); expect(session.snapshot().text).toBe('A'); expect(session.dirty).toBe(false)
})
