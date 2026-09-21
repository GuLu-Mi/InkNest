import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import { Matches, type SearchSurface } from './search-model'
export type FindCommand = 'find' | 'find-next' | 'find-previous'
export interface SearchSource { key: string; stateKey: string; version: number; label: string }
interface SearchState { open: boolean; query: string; caseSensitive: boolean; replacement: string }
export function useDocumentSearch(source: Ref<SearchSource | null>, surface: Ref<SearchSurface | null>, blocked: Ref<boolean>, liveKeys: Ref<string[]>, settle: () => Promise<boolean>) {
  const states = new Map<string, SearchState>(), empty = reactive<SearchState>({ open: false, query: '', caseSensitive: false, replacement: '' })
  const state = computed(() => {
    const key = source.value?.stateKey
    if (!key) return empty
    if (!states.has(key)) states.set(key, reactive({ open: false, query: '', caseSensitive: false, replacement: '' }))
    return states.get(key)!
  })
  const visible = computed(() => !!source.value && state.value.open && !blocked.value)
  const matches = shallowRef(new Matches()), index = ref(-1), searching = ref(false), focusRequest = ref(0), wrap = ref(''), failure = ref('')
  const composing = ref(false), replacing = ref(false), replaceNotice = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined, wrapTimer: ReturnType<typeof setTimeout> | undefined
  let replaceAbort: AbortController | null = null
  let abort: AbortController | null = null, sequence = 0, navigateOnResult = false, disposed = false, lifecycle = 0
  let anchor = 0, previousKey = '', positionPending = true
  function cancel(): void { sequence++; replaceAbort?.abort(); clearTimeout(timer); abort?.abort(); abort = null; searching.value = false; matches.value = new Matches(); index.value = -1; surface.value?.clear() }
  function reveal(): void {
    if (blocked.value || index.value < 0 || index.value >= matches.value.length) return
    const hit = matches.value.at(index.value); anchor = hit.from
    surface.value?.paint(matches.value, index.value); surface.value?.reveal(hit)
  }
  function schedule(): void {
    const key = source.value?.key ?? ''
    if (key !== previousKey) { anchor = surface.value?.position() ?? 0; positionPending = true; previousKey = key }
    const navigate = navigateOnResult; navigateOnResult = false
    cancel(); failure.value = ''; wrap.value = ''
    const target = surface.value, query = state.value.query, sensitive = state.value.caseSensitive
    if (!visible.value || !target || !query || composing.value) return
    searching.value = true
    const token = sequence; const controller = abort = new AbortController()
    timer = setTimeout(async () => {
      try {
        const found = await target.scan(query, sensitive, controller.signal)
        if (disposed || token !== sequence || controller.signal.aborted || target !== surface.value) return
        if (positionPending) { anchor = target.position(); positionPending = false }
        matches.value = found; index.value = found.length ? found.after(anchor) % found.length : -1
        searching.value = false; target.paint(found, index.value)
        if (navigate) reveal()
      } catch (error) {
        if (token === sequence && !controller.signal.aborted) { searching.value = false; failure.value = '搜索未完成，请重新输入关键词'; if (error instanceof Error && error.name === 'AbortError') failure.value = '' }
      }
    }, 150)
  }
  watch(() => source.value?.key, () => { lifecycle++; composing.value = false; replaceNotice.value = '' }, { flush: 'sync' })
  watch(blocked, () => { lifecycle++ }, { flush: 'sync' })
  watch(surface, (value, old) => { if (old && old !== value) old.dispose(); schedule() }, { flush: 'sync' })
  watch([() => source.value?.key, blocked, () => state.value.open, () => state.value.query, () => state.value.caseSensitive, composing], schedule, { flush: 'sync' })
  // CodeMirror publishes the session revision before its view finishes applying a transaction.
  // Re-index after that transaction, so clearing decorations cannot dispatch into a stale view.
  watch(() => source.value?.version, schedule, { flush: 'post' })
  watch(liveKeys, keys => { for (const key of states.keys()) if (!keys.includes(key)) states.delete(key) }, { flush: 'sync' })
  const status = computed(() => failure.value || (!surface.value ? '正文加载后可搜索' : !state.value.query ? '' : searching.value || composing.value ? '正在搜索…' : matches.value.length ? `${index.value + 1} / ${matches.value.length}` : '无结果'))
  const canNavigate = computed(() => visible.value && !replacing.value && !searching.value && !composing.value && matches.value.length > 0)
  const canReplace = computed(() => canNavigate.value && !!surface.value?.replace)
  function setReplacement(value: string): void { replaceNotice.value = ''; state.value.replacement = value }
  function setQuery(query: string): void { replaceNotice.value = ''; positionPending = true; navigateOnResult = true; state.value.query = query }
  function toggleCase(): void { navigateOnResult = true; state.value.caseSensitive = !state.value.caseSensitive }
  function move(direction: number): void {
    if (!canNavigate.value) return
    const next = index.value + direction, count = matches.value.length
    index.value = (next + count) % count
    wrap.value = next < 0 ? '已回到末尾' : next >= count ? '已回到开头' : ''
    clearTimeout(wrapTimer); if (wrap.value) wrapTimer = setTimeout(() => { wrap.value = '' }, 1800)
    reveal()
  }
  async function command(command: FindCommand): Promise<void> {
    if (!source.value || blocked.value || composing.value) return
    const owner = lifecycle, key = source.value.key, selected = surface.value?.selection() ?? ''
    if (!await settle() || owner !== lifecycle || source.value?.key !== key || blocked.value || disposed) return
    if (command === 'find' && visible.value) { close(); return }
    if (command !== 'find' && visible.value && state.value.query) { move(command === 'find-next' ? 1 : -1); return }
    if (!state.value.open) {
      anchor = surface.value?.position() ?? 0; positionPending = true; navigateOnResult = false
      if (selected && selected.length <= 256 && !/[\r\n]/u.test(selected)) state.value.query = selected
      navigateOnResult = false; state.value.open = true
    }
    await nextTick(); if (owner === lifecycle && source.value?.key === key && visible.value) focusRequest.value++
  }
  async function replace(all: boolean): Promise<void> {
    if (!canReplace.value || !source.value) return
    const target = surface.value!, owner = lifecycle, key = source.value.key, version = source.value.version
    const query = state.value.query, replacement = state.value.replacement, sensitive = state.value.caseSensitive
    const found = matches.value, selected = index.value
    replacing.value = true; replaceNotice.value = ''
    try {
      if (!await settle() || owner !== lifecycle || source.value?.key !== key || source.value.version !== version || blocked.value || composing.value || disposed || query !== state.value.query || sensitive !== state.value.caseSensitive || found !== matches.value) return
      const controller = replaceAbort = new AbortController()
      const result = await target.replace!(found, all ? null : selected, replacement, controller.signal)
      if (disposed || owner !== lifecycle || source.value?.key !== key || surface.value !== target || query !== state.value.query) return
      if (result.status === 'ok') {
        replaceNotice.value = result.count ? `已替换 ${result.count} 处` : '匹配内容与替换文本相同'
        anchor = result.nextFrom; positionPending = false; navigateOnResult = !all
        schedule()
      } else if (result.status === 'error') replaceNotice.value = result.message
    } catch (error) {
      if (owner === lifecycle && !disposed && !(error instanceof Error && error.name === 'AbortError')) replaceNotice.value = error instanceof Error ? error.message : '替换未完成，内容已保留'
    } finally { replaceAbort = null; replacing.value = false }
  }
  function close(): void { if (!visible.value) return; state.value.open = false; surface.value?.focus() }
  function escape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing.value || !visible.value || document.querySelector('dialog[open]')) return
    event.preventDefault(); event.stopImmediatePropagation(); close()
  }
  window.addEventListener('keydown', escape, true)
  onBeforeUnmount(() => { disposed = true; cancel(); surface.value?.dispose(); states.clear(); clearTimeout(wrapTimer); window.removeEventListener('keydown', escape, true) })
  return { state, visible, status, index, matches, canNavigate, focusRequest, wrap, composing, command, close, setQuery, toggleCase, move, canReplace, replacing, replaceNotice, replace, setReplacement }
}
