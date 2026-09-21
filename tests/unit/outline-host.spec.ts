import { createRenderer, ref, shallowRef } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import { useOutline, type OutlineSource } from '../../src/renderer/src/documents/use-outline'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllGlobals() })
function fixture() {
  vi.useFakeTimers()
  vi.stubGlobal('window', { innerWidth: 1920, addEventListener() {}, removeEventListener() {} })
  const source = shallowRef<OutlineSource | null>({ key: 'current/a', text: '# A\n## Child', revision: 0, unavailable: false })
  const composing = ref(false); const historyOpen = ref(false); const liveKeys = ref(['current/a', 'current/b'])
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let outline!: ReturnType<typeof useOutline>
  const app = renderer.createApp({ setup() { outline = useOutline(source, composing, historyOpen, liveKeys); return () => null } }); app.mount({}); cleanups.push(() => app.unmount())
  return { source, composing, historyOpen, outline }
}

test('passive parse waits for composition and discards pending work when active source changes', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.parsed.value?.headings[0]?.title).toBe('A')
  f.composing.value = true; f.source.value = { ...f.source.value!, text: '# Uncommitted', revision: 1 }
  await vi.advanceTimersByTimeAsync(500)
  expect(f.outline.parsed.value?.headings[0]?.title).toBe('A')
  f.composing.value = false; await vi.advanceTimersByTimeAsync(149)
  expect(f.outline.parsed.value?.headings[0]?.title).toBe('A')
  f.source.value = { key: 'current/b', text: '# B', revision: 0, unavailable: false }
  await vi.advanceTimersByTimeAsync(200)
  expect(f.outline.parsed.value?.headings[0]?.title).toBe('B')
})

test('current and historical fold/scroll ownership remains independent and oversized text skips parsing', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  f.outline.toggle('inknest-heading-0'); f.outline.setTop('current/a', 120)
  f.source.value = { key: 'history/h1', text: '# Historical\n## Old child', revision: 0, unavailable: false }; await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.state.value.collapsed.size).toBe(0)
  f.outline.toggle('inknest-heading-0'); f.outline.setTop('history/h1', 70)
  f.source.value = { key: 'current/a', text: '# A\n## Child', revision: 0, unavailable: false }; await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.state.value.collapsed.has('inknest-heading-0')).toBe(true)
  expect(f.outline.state.value.top).toBe(120)
  f.source.value = { key: 'current/large', text: '# Large', revision: 0, unavailable: true }; await vi.advanceTimersByTimeAsync(200)
  expect(f.outline.parsed.value).toBeNull(); expect(f.outline.reason.value).toContain('大文件')
})

test('docked panels coexist and insufficient margins use mutually exclusive sidebars', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.visible.value).toBe(true)
  f.historyOpen.value = true
  expect(f.outline.visible.value).toBe(true)
  f.historyOpen.value = false
  expect(f.outline.visible.value).toBe(true)
  f.outline.width.value = 800; f.historyOpen.value = true; f.outline.toggleOpen()
  expect(f.outline.visible.value).toBe(true); expect(f.historyOpen.value).toBe(false)
  f.outline.close(); expect(f.outline.visible.value).toBe(false)
  f.outline.width.value = 1920; expect(f.outline.visible.value).toBe(false)
})

test('explicit navigation resolves a heading against the latest source line before debounce', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  const oldHeadings = f.outline.state.value.headings
  f.source.value = { ...f.source.value!, text: 'inserted\n\n# A\n## Child', revision: 1 }
  expect(f.outline.resolveHeading(oldHeadings[1]!, oldHeadings)?.sourceLine).toBe(3)
  f.source.value = { ...f.source.value!, text: '# Removed', revision: 2 }
  expect(f.outline.resolveHeading(oldHeadings[1]!, oldHeadings)).toBeNull()
})

test('editor active heading follows the latest observed source line after insert remove and reorder debounce', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  f.outline.observeSourceLine('current/a', 1)
  expect(f.outline.active.value).toBe('inknest-heading-1')
  f.source.value = { ...f.source.value!, text: '# Inserted\n# A\n## Child', revision: 1 }
  f.outline.observeSourceLine('current/a', 2)
  await vi.advanceTimersByTimeAsync(150)
  expect(f.outline.active.value).toBe('inknest-heading-2')
  f.composing.value = true
  f.source.value = { ...f.source.value!, text: '# Inserted\n## Child', revision: 2 }; f.outline.observeSourceLine('current/a', 1)
  await vi.advanceTimersByTimeAsync(200)
  expect(f.outline.parsed.value?.headings).toHaveLength(3)
  f.composing.value = false; await vi.advanceTimersByTimeAsync(150)
  expect(f.outline.active.value).toBe('inknest-heading-1')
  f.source.value = { ...f.source.value!, text: 'preamble\n## Child\n# Inserted', revision: 3 }; await vi.advanceTimersByTimeAsync(150)
  expect(f.outline.active.value).toBe('inknest-heading-0')
  f.source.value = { key: 'current/b', text: '# B', revision: 0, unavailable: false }; await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.active.value).toBe('')
})

test('shrinking with both panels open leaves one compact sidebar and restores explicit outline preference', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  f.outline.close(); f.outline.toggleOpen(); f.historyOpen.value = true
  expect(f.outline.visible.value).toBe(true)
  f.outline.width.value = 800
  expect(f.outline.visible.value).toBe(false)
  f.historyOpen.value = false
  expect(f.outline.visible.value).toBe(true)
})

test('outline opening and closing belong to their document rather than the window', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(0)
  f.outline.close()
  f.source.value = { key: 'current/b', text: '# B', revision: 0, unavailable: false }; await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.visible.value).toBe(true)
  f.source.value = { key: 'current/a', text: '# A', revision: 0, unavailable: false }; await vi.advanceTimersByTimeAsync(0)
  expect(f.outline.visible.value).toBe(false)
})
