import { createRenderer, ref, shallowRef } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import { Matches, type SearchSurface } from '../../src/renderer/src/search/search-model'
import { useDocumentSearch, type SearchSource } from '../../src/renderer/src/search/use-document-search'
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.useRealTimers(); vi.unstubAllGlobals() })
function fixture(settle: () => Promise<boolean> = async () => true) {
  vi.useFakeTimers(); vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const source = ref<SearchSource | null>({ key: 'A/read', stateKey: 'A', version: 0, label: 'A' }), blocked = ref(false), keys = ref(['A','B'])
  const pending: { query: string; resolve: (value: Matches) => void; signal: AbortSignal }[] = []
  const target: SearchSurface = { scan: (query, _sensitive, signal) => new Promise(resolve => pending.push({ query, resolve, signal })), paint: vi.fn(), reveal: vi.fn(), position: () => 0, selection: () => '', focus: vi.fn(), clear: vi.fn(), dispose: vi.fn() }
  const surface = shallowRef<SearchSurface | null>(target)
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let ui!: ReturnType<typeof useDocumentSearch>
  const app = renderer.createApp({ setup() { ui = useDocumentSearch(source, surface, blocked, keys, settle); return () => null } }); app.mount({}); cleanup.push(() => app.unmount())
  const complete = (index: number, count: number) => { const value = new Matches(); for (let i = 0; i < count; i++) value.add(i * 10, i * 10 + 2); pending[index]!.resolve(value) }
  return { ui, source, surface, blocked, keys, pending, target, complete }
}
test('rejects late replies, keeps per-source state, wraps and releases modal/closed results', async () => {
  const f = fixture(); await f.ui.command('find'); f.ui.setQuery('old'); await vi.advanceTimersByTimeAsync(150)
  f.ui.setQuery('new'); await vi.advanceTimersByTimeAsync(150)
  expect(f.pending[0]!.signal.aborted).toBe(true)
  f.complete(1, 2); await Promise.resolve(); expect(f.ui.status.value).toBe('1 / 2')
  f.complete(0, 8); await Promise.resolve(); expect(f.ui.status.value).toBe('1 / 2')
  f.ui.move(-1); expect(f.ui.status.value).toBe('2 / 2'); expect(f.ui.wrap.value).toBe('已回到末尾')
  f.source.value = { key: 'B/read', stateKey: 'B', version: 0, label: 'B' }; expect(f.ui.visible.value).toBe(false)
  await f.ui.command('find'); f.ui.setQuery('other')
  f.source.value = { key: 'A/edit', stateKey: 'A', version: 1, label: 'A' }; expect(f.ui.state.value.query).toBe('new'); expect(f.ui.visible.value).toBe(true)
  f.blocked.value = true; expect(f.ui.visible.value).toBe(false); expect(f.ui.matches.value.length).toBe(0)
  f.blocked.value = false; f.ui.close(); expect(f.target.focus).toHaveBeenCalled(); expect(f.ui.visible.value).toBe(false)
  f.surface.value = null; expect(f.target.dispose).toHaveBeenCalledOnce()
})
test('history cache is isolated and removed when its source is no longer live', async () => {
  const f = fixture(); await f.ui.command('find'); f.ui.setQuery('current')
  f.keys.value = ['A', 'history']; f.source.value = { key: 'history/1', stateKey: 'history', version: 0, label: 'history' }
  await f.ui.command('find'); f.ui.setQuery('past')
  f.source.value = { key: 'history/2', stateKey: 'history', version: 0, label: 'history' }; expect(f.ui.state.value.query).toBe('past')
  f.source.value = { key: 'A/read', stateKey: 'A', version: 0, label: 'A' }; f.keys.value = ['A']; expect(f.ui.state.value.query).toBe('current')
  f.source.value = { key: 'history/3', stateKey: 'history', version: 0, label: 'history' }; expect(f.ui.state.value.query).toBe('')
})

test('selection-only publications do not erase results or recursively re-index the editor', async () => {
  const f = fixture()
  vi.mocked(f.target.paint).mockImplementation(() => { f.source.value = { ...f.source.value! } })
  await f.ui.command('find'); f.ui.setQuery('same'); await vi.advanceTimersByTimeAsync(150)
  f.complete(0, 2); await Promise.resolve(); await vi.advanceTimersByTimeAsync(200)
  expect(f.pending).toHaveLength(1); expect(f.ui.status.value).toBe('1 / 2')
  f.ui.move(1); await vi.advanceTimersByTimeAsync(200)
  expect(f.pending).toHaveLength(1); expect(f.ui.status.value).toBe('2 / 2')
  f.source.value = { ...f.source.value!, version: 1 }; await vi.advanceTimersByTimeAsync(150)
  expect(f.pending).toHaveLength(2)
})


test('a find request awaiting IME settlement cannot reopen a source after leaving and returning', async () => {
  let finish!: (value: boolean) => void
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  const pending = f.ui.command('find')
  const original = f.source.value
  f.source.value = { key: 'B/read', stateKey: 'B', version: 0, label: 'B' }; f.source.value = original
  finish(true); await pending
  expect(f.ui.visible.value).toBe(false)
})

test('find toggles visibility and reopening cached matches never scrolls or changes selection', async () => {
  const f = fixture(); await f.ui.command('find'); f.ui.setQuery('text'); await vi.advanceTimersByTimeAsync(150); f.complete(0, 3); await Promise.resolve()
  vi.mocked(f.target.reveal).mockClear()
  await f.ui.command('find'); expect(f.ui.visible.value).toBe(false)
  await f.ui.command('find'); await vi.advanceTimersByTimeAsync(150); f.complete(1, 3); await Promise.resolve()
  expect(f.ui.visible.value).toBe(true); expect(f.ui.state.value.query).toBe('text'); expect(f.target.reveal).not.toHaveBeenCalled()
  f.ui.move(1); expect(f.target.reveal).toHaveBeenCalledOnce()
})
test('preview surfaces cannot replace', async () => {
  const f = fixture(); await f.ui.command('find'); f.ui.setQuery('a'); await vi.advanceTimersByTimeAsync(150); f.complete(0, 1); await Promise.resolve()
  expect(f.ui.canReplace.value).toBe(false)
})

test.each(['query', 'source', 'blocked'] as const)('replacement waiting for IME settlement is refused after %s changes', async kind => {
  let finish: ((value: boolean) => void) | undefined
  let waiting = false
  const f = fixture(() => waiting ? new Promise(resolve => { finish = resolve }) : Promise.resolve(true))
  f.target.replace = vi.fn(async () => ({ status: 'ok', count: 1, nextFrom: 0 }))
  await f.ui.command('find'); f.ui.setQuery('a'); await vi.advanceTimersByTimeAsync(150); f.complete(0, 1); await Promise.resolve()
  expect(f.ui.canReplace.value).toBe(true); waiting = true
  const pending = f.ui.replace(true)
  if (kind === 'query') f.ui.setQuery('b')
  else if (kind === 'source') f.source.value = { key: 'B/edit', stateKey: 'B', version: 0, label: 'B' }
  else f.blocked.value = true
  finish!(true); await pending
  expect(f.target.replace).not.toHaveBeenCalled(); expect(f.ui.replacing.value).toBe(false)
})
