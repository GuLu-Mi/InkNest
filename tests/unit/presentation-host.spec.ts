import { createRenderer, customRef, nextTick, ref, type Ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppEvent, OpenDocument, PresentationRequest } from '../../src/shared/contracts'
import { useWorkspace } from '../../src/renderer/src/documents/use-workspace'
import { restoreHistory } from '../../src/renderer/src/documents/history-actions'
import { usePresentation } from '../../src/renderer/src/presentation/use-presentation'
const source: OpenDocument = { docId: 'source', epoch: 'epoch', displayName: 'source.md', displayPath: '/one/source.md', text: '# current', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'disk', readOnlyReason: null, recovered: false, readingPosition: null }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
function fixture(settle = async () => true, blocked: Ref<boolean> = ref(false)) {
  let saves = 0
  const requests: PresentationRequest[] = []; const listeners = new Set<(event: AppEvent) => void>()
  vi.stubGlobal('window', { inknest: { save: async () => { saves++; return { status: 'cancelled' } }, onEvent: (fn: (event: AppEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn) }, setPresentation: async (request: PresentationRequest) => { requests.push(request); return { status: 'ok', value: undefined } } } })
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let ws!: ReturnType<typeof useWorkspace>; let ui!: ReturnType<typeof usePresentation>
  const app = renderer.createApp({ setup() { ws = useWorkspace(ref(undefined), { presentation: () => ui.enter() }); ui = usePresentation(ws, settle, blocked); return () => null } }); app.mount({}); ws.workspace.install({ ...source })
  let mounted = true; const unmount = () => { if (mounted) { app.unmount(); mounted = false } }; cleanups.push(unmount)
  const event = (value: AppEvent) => { for (const fn of listeners) fn(value) }
  const confirm = (enabled: boolean, request = requests.at(-1)!) => event({ type: 'presentation-state', ...request, enabled, fullscreen: enabled })
  return { saves: () => saves, ws, ui, requests, blocked, confirm, event, unmount }
}
test('presentation captures settled real text and native acceptance alone cannot mount it', async () => {
  let release!: (value: boolean) => void; const f = fixture(() => new Promise(resolve => { release = resolve }))
  const session = f.ws.session.value!; const entering = f.ui.enter(); expect(f.requests).toHaveLength(0)
  session.apply([session.state.update({ changes: { from: 0, to: 9, insert: '# committed' } })]); release(true); await entering
  expect(f.ui.active.value).toBe(false); expect(f.ui.snapshot.value?.text).toBe('# committed'); f.confirm(true)
  expect(f.ui.active.value).toBe(true); expect(f.ui.parsed.value?.headings[0]?.title).toBe('committed')
  session.apply([session.state.update({ changes: { from: 0, to: 11, insert: '# underlying' } })]); expect(f.ui.snapshot.value?.text).toBe('# committed')
  await f.ui.exit(); expect(f.ui.snapshot.value).toBeNull(); expect(f.ws.session.value).toBe(session); expect(session.snapshot().text).toBe('# underlying')
})
test.each(['switch', 'epoch', 'remove', 'block', 'dispose'] as const)('%s during IME cannot dispatch a stale presentation request', async action => {
  let release!: (value: boolean) => void; const f = fixture(() => new Promise(resolve => { release = resolve })); const entering = f.ui.enter()
  if (action === 'switch') { const other = { ...source, docId: 'other' }; f.ws.workspace.install(other); f.ws.workspace.activate(source) }
  if (action === 'epoch') f.ws.workspace.replace(source, { ...source, epoch: 'new' })
  if (action === 'remove') f.ws.workspace.remove(source)
  if (action === 'block') f.blocked.value = true
  if (action === 'dispose') f.unmount()
  release(true); await entering; expect(f.requests).toHaveLength(0); expect(f.ui.snapshot.value).toBeNull()
})
test('new tab activation exits without reactivating source and keeps original view', async () => {
  const f = fixture(); f.ws.workspace.setView(source, { mode: 'edit', editorTop: 120, reading: { top: 45, ratio: .2, revision: 0 } })
  await f.ui.enter(); f.confirm(true); f.ui.bookmark.value = { top: 900, ratio: .8, revision: 0 }
  f.ws.workspace.install({ ...source, docId: 'other', epoch: 'other', displayPath: '/other.md' }); await nextTick()
  expect(f.ui.snapshot.value).toBeNull(); expect(f.ws.workspace.active?.docId).toBe('other'); expect(f.ws.workspace.getView(source)).toMatchObject({ mode: 'edit', editorTop: 120, reading: { top: 45 } }); expect(f.requests.at(-1)?.enabled).toBe(false)
})
test('stale native receipt cannot revive an exited snapshot and failure only belongs to pending entry', async () => {
  const f = fixture(); await f.ui.enter(); const first = f.requests[0]!; await f.ui.exit(); f.confirm(true, first)
  expect(f.ui.active.value).toBe(false); expect(f.ui.error.value).toBe(''); f.confirm(false)
  await f.ui.enter(); f.confirm(false); expect(f.ui.snapshot.value).toBeNull(); expect(f.ui.error.value).not.toBe('')
  await f.ui.enter(); f.confirm(true); f.confirm(false); expect(f.ui.error.value).toBe('')
})
test('entry admission blocks all ordinary busy/frozen states and workspace pending restore surface gate', async () => {
  const f = fixture(); f.blocked.value = true; await f.ui.enter(); expect(f.requests).toHaveLength(0)
  f.blocked.value = false; f.ws.busy.value = true; await f.ui.enter(); expect(f.requests).toHaveLength(0)
  f.ws.busy.value = false; f.ws.workspace.getTab(source)!.frozen = true; f.ws.workspace.changed(); await f.ui.enter(); expect(f.requests).toHaveLength(0)
})

// The surface gate includes history display, backup activity and unresolved restore,
// including when the pending source is in another tab.
test('native presentation command uses the same surface gate and never falls through to save', async () => {
  const f = fixture(); const session = f.ws.session.value!; session.apply([session.state.update({ changes: { from: 0, insert: 'dirty' } })]); f.blocked.value = true
  f.event({ type: 'menu-command', command: 'presentation' }); await nextTick()
  expect(f.requests).toHaveLength(0); expect(f.ui.snapshot.value).toBeNull(); expect(f.saves()).toBe(0)
  f.blocked.value = false; f.event({ type: 'menu-command', command: 'presentation' }); await nextTick(); await nextTick()
  expect(f.requests).toHaveLength(1); expect(f.requests[0]?.enabled).toBe(true)
})
test('entry bookmark is restored even when native window resize updates the hidden original view', async () => {
  const f = fixture(); f.ws.workspace.setView(source, { mode: 'read', reading: { top: 420, ratio: .4, revision: 0 }, editorTop: 88 })
  await f.ui.enter(); f.ws.workspace.setView(source, { reading: { top: 500, ratio: .6, revision: 0 }, editorTop: 100 }); f.confirm(true)
  await f.ui.exit(); expect(f.ws.workspace.getView(source)).toMatchObject({ reading: { top: 420, ratio: .4 }, editorTop: 88 })
})

test('unresolved history receipt in another tab blocks native presentation with ordinary tab editing still available', async () => {
  const f = fixture(); const target = { id: 'history', text: '# historical', savedAt: '2026-09-17T00:00:00Z', contentHash: 'a'.repeat(64), byteLength: 12, format: source.format, restorable: true, source: 'manual' as const, sealed: true }
  f.ws.tab.value!.frozen = true; f.ws.session.value!.setFrozen(true)
  await restoreHistory(f.ws.workspace, f.ws.tab.value!, target, async () => { throw new Error('lost restore reply') })
  f.ws.tab.value!.frozen = false; f.ws.session.value!.setFrozen(false); f.ws.workspace.changed()
  expect(f.ws.historyRestorePending.value).not.toBeNull()
  f.ws.workspace.install({ ...source, docId: 'other', epoch: 'other', displayPath: '/other.md' }); expect(f.ws.editingFrozen.value).toBe(false)
  f.event({ type: 'menu-command', command: 'presentation' }); await nextTick(); await nextTick()
  expect(f.requests).toHaveLength(0); expect(f.saves()).toBe(0)
})


test.each(['blocked', 'busy', 'frozen', 'backups'] as const)('pending native request cancels when %s becomes forbidden and late receipt cannot revive it', async gate => {
  const f = fixture(); const session = f.ws.session.value!
  session.apply([session.state.update({ changes: { from: 0, insert: 'LOCAL ' } })])
  await f.ui.enter(); const entering = f.requests[0]!
  expect(f.ui.pending.value).toBe(true); expect(f.ui.snapshot.value).not.toBeNull()
  if (gate === 'blocked') f.blocked.value = true
  if (gate === 'busy') f.ws.busy.value = true
  if (gate === 'frozen') { f.ws.workspace.getTab(source)!.frozen = true; f.ws.workspace.changed() }
  if (gate === 'backups') f.ws.backupsOpen.value = true
  expect(f.requests.map(request => request.enabled)).toEqual([true, false])
  f.confirm(true, entering); f.event({ type: 'menu-command', command: 'presentation' }); await nextTick()
  expect(f.ui.active.value).toBe(false); expect(f.ui.snapshot.value).toBeNull(); expect(f.ui.error.value).toBe('')
  expect(f.ws.session.value).toBe(session); expect(session.snapshot().text).toBe('LOCAL # current'); expect(f.saves()).toBe(0)
})

test('enabled receipt checks current gate before its watcher notification can run', async () => {
  // Defer reactive notification deliberately: receipt admission must read the gate itself.
  let current = false; let notify!: () => void
  const blocked = customRef<boolean>((track, trigger) => { notify = trigger; return { get() { track(); return current }, set(value) { current = value } } })
  const f = fixture(async () => true, blocked); await f.ui.enter(); const entering = f.requests[0]!
  blocked.value = true; f.confirm(true, entering)
  expect(f.ui.active.value).toBe(false); expect(f.requests.map(request => request.enabled)).toEqual([true, false])
  expect(f.ui.snapshot.value).toBeNull(); notify(); await nextTick(); expect(f.saves()).toBe(0)
})

test.each(['busy', 'editingFrozen'] as const)('repeated enabled receipt preserves active presentation during transient %s', async gate => {
  const f = fixture(); await f.ui.enter(); f.confirm(true); const snapshot = f.ui.snapshot.value
  if (gate === 'busy') f.ws.busy.value = true
  else { f.ws.workspace.getTab(source)!.frozen = true; f.ws.workspace.getTab(source)!.session!.setFrozen(true); f.ws.workspace.changed() }
  expect(f.ui.active.value).toBe(true)
  f.confirm(true, f.requests[0]!)
  expect(f.ui.active.value).toBe(true); expect(f.ui.snapshot.value).toBe(snapshot); expect(f.requests).toHaveLength(1)
  f.blocked.value = true
  expect(f.ui.snapshot.value).toBeNull(); expect(f.requests.at(-1)?.enabled).toBe(false)
})
