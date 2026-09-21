import { createRenderer, nextTick, ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import type { HistorySnapshot, OpenDocument, Result } from '../../src/shared/contracts'
import { useWorkspace } from '../../src/renderer/src/documents/use-workspace'
import { useHistory } from '../../src/renderer/src/documents/use-history'

const source: OpenDocument = { docId: 'source', epoch: 'epoch', displayName: 'source.md', displayPath: '/one/source.md', text: 'current', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'disk', readOnlyReason: null, recovered: false, readingPosition: null }
const snapshot = (id: string): HistorySnapshot => ({ id, savedAt: '2026-09-17T00:00:00Z', contentHash: 'a'.repeat(64), byteLength: 4, format: source.format, text: 'old ' + id, restorable: true, source: 'manual' as const, sealed: true })
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals() })
function fixture(beforeEnter: () => Promise<boolean> = async () => true, initial: OpenDocument = source) {
  const reads: { id: string; resolve: (result: Result<HistorySnapshot>) => void }[] = []; let lists = 0
  const exports: { ref: unknown; id: string }[] = []
  vi.stubGlobal('window', { innerWidth: 1920, addEventListener() {}, removeEventListener() {}, inknest: { onEvent: () => () => {}, exportHistory: async (ref: unknown, id: string) => { exports.push({ ref, id }); return { status: 'ok', value: undefined } }, listHistory: async () => { lists++; return { status: 'ok', value: { generation: 0, entries: [] } } }, inspectHistory: (_ref: unknown, id: string) => new Promise<Result<HistorySnapshot>>(resolve => reads.push({ id, resolve })) } })
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let ws!: ReturnType<typeof useWorkspace>; let ui!: ReturnType<typeof useHistory>
  const app = renderer.createApp({ setup() { ws = useWorkspace(ref(undefined)); ui = useHistory(ws, beforeEnter); return () => null } }); app.mount({})
  ws.workspace.install({ ...initial }); let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }; cleanups.push(unmount)
  return { ws, ui, reads, exports, lists: () => lists, unmount }
}

test('host path generation rejects a pending reply even after migration returns to the original path', async () => {
  const f = fixture(); const reading = f.ui.enter('A'); await nextTick()
  const doc = f.ws.workspace.get(source)!; doc.displayPath = '/two/source.md'; f.ws.workspace.changed(); doc.displayPath = source.displayPath; f.ws.workspace.changed()
  f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await reading
  expect(f.ui.preview.value).toBeNull(); expect(f.ws.session.value!.snapshot().text).toBe('current')
})

test('metadata refresh ignores scroll and edit notifications; source display classification uses historical size', async () => {
  const f = fixture(); f.ui.open.value = true; await nextTick(); await nextTick(); const before = f.lists()
  f.ws.workspace.setView(source, { reading: { top: 100, ratio: .5, revision: 0 } }); f.ws.workspace.changed(); await nextTick()
  expect(f.lists()).toBe(before)
  const doc = f.ws.workspace.get(source)!; doc.readOnlyReason = 'size'; f.ws.workspace.changed()
  const reading = f.ui.enter('A'); await nextTick(); f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await reading
  expect(f.ui.displayed.value?.readOnlyReason).toBeNull(); expect(f.ui.displayed.value?.text).toBe('old A')
  f.ws.workspace.setView(source, { reading: { top: 150, ratio: .7, revision: 0 } }); f.ui.exit()
  expect(f.ws.workspace.getView(source).reading.top).toBe(100)
})

test('switching away and back releases historical body and restores per-tab list scroll', async () => {
  const f = fixture(); f.ws.workspace.register({ ...source, docId: 'other', epoch: 'other', displayPath: '/other.md' }); f.ui.setTop(source, 120)
  const reading = f.ui.enter('A'); await nextTick(); f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await reading
  f.ws.workspace.activate({ docId: 'other', epoch: 'other' }); expect(f.ui.preview.value).toBeNull(); expect(f.ui.top.value).toBe(0); f.ui.setTop({ docId: 'other', epoch: 'other' }, 60)
  f.ws.workspace.activate(source); expect(f.ui.top.value).toBe(120); expect(f.ui.displayed.value).toBeNull()
})

test('a restore clicked on A cannot restore a later B selection when A finishes last', async () => {
  const f = fixture(); const targets: string[] = []
  // Replace only the destructive action boundary; the actual UI selection controller and async ownership run unchanged.
  f.ws.restoreHistory = async target => { targets.push(target.id); return false }
  const restoring = f.ui.restore('A'); await nextTick()
  const second = f.ui.enter('B'); await nextTick()
  f.reads[1]!.resolve({ status: 'ok', value: snapshot('B') }); await second
  f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await restoring
  expect(f.ui.preview.value?.historyId).toBe('B'); expect(targets).toEqual([])
})

test('failed save outcome does not refresh historical metadata without a new disk baseline', async () => {
  const f = fixture(); f.ui.open.value = true; await nextTick(); await nextTick(); const before = f.lists()
  const requestId = 'failed-request'; f.ws.session.value!.captureSave(requestId)
  f.ws.workspace.failSave(source, requestId, 'failure', 'deliberate failure'); await nextTick(); await nextTick()
  expect(f.lists()).toBe(before)
})


function deferredSettlement() {
  let release!: (ready: boolean) => void
  const promise = new Promise<boolean>(resolve => { release = resolve })
  return { promise, release }
}

test.each(['exit', 'close', 'cleanup', 'switch-away-back', 'migrate-away-back', 'epoch-replace', 'source-remove', 'dispose', 'frozen'] as const)('%s invalidates an entry waiting for composition before any historical read', async action => {
  const settlement = deferredSettlement(); const f = fixture(() => settlement.promise)
  const session = f.ws.session.value!; const state = session.state
  f.ws.workspace.setView(source, { mode: 'edit', editorTop: 42 }); f.ui.open.value = true
  const entering = f.ui.enter('A')
  if (action === 'exit') f.ui.exit()
  else if (action === 'close') f.ui.close()
  else if (action === 'cleanup') f.ui.cleaned()
  else if (action === 'switch-away-back') {
    const other = { ...source, docId: 'other', epoch: 'other', displayPath: '/other.md' }
    f.ws.workspace.register(other); f.ws.workspace.activate(other); f.ws.workspace.activate(source)
  } else if (action === 'migrate-away-back') {
    const doc = f.ws.workspace.get(source)!; doc.displayPath = '/two/source.md'; f.ws.workspace.changed(); doc.displayPath = source.displayPath; f.ws.workspace.changed()
  } else if (action === 'epoch-replace') f.ws.workspace.replace(source, { ...source, epoch: 'replacement' })
  else if (action === 'source-remove') f.ws.workspace.remove(source)
  else if (action === 'dispose') f.unmount()
  else { f.ws.workspace.getTab(source)!.frozen = true; session.setFrozen(true); f.ws.workspace.changed() }
  settlement.release(true); await nextTick()
  // Finish any incorrectly issued read so RED fails on the missing ownership guard, never on a timeout.
  for (const read of f.reads) read.resolve({ status: 'ok', value: snapshot(read.id) })
  await entering
  expect(f.reads).toHaveLength(0); expect(f.ui.preview.value).toBeNull(); expect(f.ui.displayed.value).toBeNull()
  expect(session.state).toBe(state); expect(session.snapshot().text).toBe('current')
  if (action === 'close') expect(f.ui.open.value).toBe(false)
  if (f.ws.workspace.getTab(source)) expect(f.ws.workspace.getView(source)).toMatchObject({ mode: 'edit', editorTop: 42 })
})

test('latest history intent wins when B settles before A, and closing still permits a later fresh entry', async () => {
  const settlements = [deferredSettlement(), deferredSettlement(), deferredSettlement()]; let index = 0
  const f = fixture(() => settlements[index++]!.promise)
  const first = f.ui.enter('A'); const second = f.ui.enter('B')
  settlements[1]!.release(true); await nextTick(); f.reads[0]!.resolve({ status: 'ok', value: snapshot('B') }); await second
  settlements[0]!.release(true); await nextTick()
  for (const read of f.reads.slice(1)) read.resolve({ status: 'ok', value: snapshot(read.id) })
  await first
  expect(f.reads.map(read => read.id)).toEqual(['B']); expect(f.ui.displayed.value?.text).toBe('old B')
  f.ui.close(); const fresh = f.ui.enter('C'); settlements[2]!.release(true); await nextTick()
  f.reads.at(-1)!.resolve({ status: 'ok', value: snapshot('C') }); await fresh
  expect(f.ui.displayed.value?.text).toBe('old C')
})


test.each(['readonly', 'missing', 'unavailable', 'recoveryPending'] as const)('%s keeps history view/export usable while restore remains blocked', async gate => {
  const f = fixture(async () => true, gate === 'readonly' ? { ...source, readOnlyReason: 'link' } : source)
  const tab = f.ws.workspace.getTab(source)!
  if (gate === 'missing' || gate === 'unavailable') tab.diskStatus = gate
  if (gate === 'recoveryPending') tab.recoveryPending = true
  f.ws.workspace.changed()
  const reading = f.ui.enter('A'); await nextTick(); f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await reading
  expect(f.ui.displayed.value?.text).toBe('old A'); expect(f.ui.restoreBlocked.value).toBe(true)
  await f.ui.restore(); expect(f.ui.displayed.value?.text).toBe('old A')
  expect(await f.ui.exportSelected()).toBe(true); expect(f.exports).toEqual([{ ref: { docId: source.docId, epoch: source.epoch }, id: 'A' }])
  if (gate === 'recoveryPending') expect(tab.recoveryPending).toBe(true)
  f.ui.exit(); expect(f.ui.preview.value).toBeNull(); expect(tab.document.text).toBe('current')
})


test('history generations refresh an open list even when the disk token is unchanged', async () => {
  const f = fixture(); f.ui.open.value = true; await nextTick(); await nextTick()
  const before = f.lists(); const token = f.ws.document.value!.diskToken
  f.ws.workspace.acceptHistoryChange({ type: 'history-changed', ref: source, displayPath: source.displayPath!, generation: 2 })
  await nextTick(); await nextTick()
  expect(f.lists()).toBeGreaterThan(before); expect(f.ws.document.value!.diskToken).toBe(token)
})
test('a removed auto version keeps its preview text but can no longer be exported or restored', async () => {
  const f = fixture(); const reading = f.ui.enter('A'); await nextTick()
  f.reads[0]!.resolve({ status: 'ok', value: snapshot('A') }); await reading
  await f.ui.refresh()
  expect(f.ui.preview.value?.snapshot?.text).toBe('old A')
  expect(f.ui.preview.value?.available).toBe(false)
  await f.ui.exportSelected(); expect(f.exports).toHaveLength(0)
})

test('history visibility belongs to each live document and new epochs start closed', async () => {
  const f = fixture(); f.ui.open.value = true
  const other = { ...source, docId: 'other', epoch: 'other', displayPath: '/two.md' }
  f.ws.workspace.install(other)
  expect(f.ui.open.value).toBe(false)
  f.ui.open.value = true
  f.ws.workspace.activate(source); expect(f.ui.open.value).toBe(true)
  f.ui.open.value = false
  f.ws.workspace.activate(other); expect(f.ui.open.value).toBe(true)
  f.ws.workspace.install({ ...source, epoch: 'new' }); expect(f.ui.open.value).toBe(false)
})
