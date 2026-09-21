import { computed, onBeforeUnmount, reactive, ref, shallowRef, triggerRef, watch, type Ref } from 'vue'
import { parseDocument, type HeadingEntry, type ParsedDocument } from '../preview/document-model'
import { canShowBothPanels, OUTLINE_WIDTH, panelFits } from './panel-layout'
import { matchHeading, OutlineState } from './outline-state'
export interface OutlineSource { key: string; text: string; revision: number; unavailable: boolean }
export function useOutline(source: Ref<OutlineSource | null>, composing: Ref<boolean>, historyOpen: Ref<boolean>, liveKeys: Ref<string[]>, layoutSuspended: Ref<boolean> = ref(false), ownerKey: Ref<string> = computed(() => source.value?.key ?? '')) {
  const createState = () => reactive(new OutlineState())
  const parsed = shallowRef<ParsedDocument | null>(null); const state = shallowRef(createState()); const width = ref(window.innerWidth)
  const preferences = reactive(new Map<string, boolean>())
  const preferred = computed({ get: () => preferences.get(ownerKey.value) ?? null, set: (value: boolean | null) => { if (ownerKey.value) { if (value === null) preferences.delete(ownerKey.value); else preferences.set(ownerKey.value, value) } } }); const active = ref(''); const error = ref('')
  let sourceLine: number | null = null
  const states = new Map<string, OutlineState>(); let timer: ReturnType<typeof setTimeout> | undefined; let generation = 0; let parsedRevision = -1
  const compact = computed(() => !panelFits(width.value, OUTLINE_WIDTH))
  const visible = computed(() => !!source.value && !(!canShowBothPanels(width.value) && historyOpen.value) && (preferred.value ?? !compact.value) && (state.value.headings.length > 0 || preferred.value === true))
  const reason = computed(() => source.value?.unavailable ? '大文件使用纯文本阅读，目录暂不可用' : error.value || (!parsed.value ? '正在生成目录…' : '此文档没有标题'))
  function close(): void { preferred.value = false }
  function toggleOpen(): void {
    if (visible.value) { close(); return }
    if (!canShowBothPanels(width.value)) historyOpen.value = false
    preferred.value = true
  }
  function toggle(id: string): void { state.value.toggle(id); triggerRef(state) }
  function setTop(key: string, top: number): void { const owner = states.get(key); if (owner) owner.top = top }
  function setActive(key: string, id: string): void { if (source.value?.key === key) { sourceLine = null; active.value = id } }
  function observeSourceLine(key: string, line: number): void {
    if (source.value?.key !== key) return
    sourceLine = line; updateActiveLine()
  }
  function updateActiveLine(): void {
    if (sourceLine === null) return
    let id = ''; for (const heading of state.value.headings) { if (heading.sourceLine <= sourceLine) id = heading.id; else break }
    active.value = id
  }
  watch([() => source.value?.key, () => source.value?.revision, () => source.value?.unavailable, composing, layoutSuspended], (next, previous) => {
    clearTimeout(timer); const current = ++generation; const snapshot = source.value
    const changed = !previous || next[0] !== previous[0]
    if (changed) {
      parsed.value = null; parsedRevision = -1; sourceLine = null; active.value = ''; error.value = ''
      for (const key of states.keys()) if (key.startsWith('history/') && key !== snapshot?.key) states.delete(key)
      state.value = snapshot ? states.get(snapshot.key) ?? createState() : createState()
      if (snapshot) states.set(snapshot.key, state.value)
    }
    if (!snapshot || snapshot.unavailable) { parsed.value = null; state.value.update([]); triggerRef(state); return }
    if (composing.value || layoutSuspended.value) return
    timer = setTimeout(() => {
      if (generation !== current || source.value?.key !== snapshot.key || composing.value) return
      refresh(snapshot)
    }, changed ? 0 : 150)
  }, { immediate: true, flush: 'sync' })
  watch(liveKeys, keys => { for (const key of preferences.keys()) if (!keys.includes(key)) preferences.delete(key); for (const key of states.keys()) if (key.startsWith('current/') && !keys.includes(key)) states.delete(key) }, { flush: 'sync' })
  watch(historyOpen, value => { if (value && !canShowBothPanels(width.value)) preferred.value = false }, { flush: 'sync' })
  watch(layoutSuspended, value => { if (!value) resize() })
  const resize = () => { if (!layoutSuspended.value) width.value = window.innerWidth }
  window.addEventListener('resize', resize)
  onBeforeUnmount(() => { clearTimeout(timer); generation++; states.clear(); preferences.clear(); window.removeEventListener('resize', resize) })
  function refresh(snapshot: OutlineSource): void {
    try { const result = parseDocument(snapshot.text); state.value.update(result.headings); updateActiveLine(); triggerRef(state); parsed.value = result; parsedRevision = snapshot.revision; error.value = '' }
    catch { parsed.value = null; error.value = '目录解析失败' }
  }
  function resolveHeading(heading: HeadingEntry, before: HeadingEntry[]): HeadingEntry | null {
    const snapshot = source.value
    if (!snapshot || composing.value || snapshot.unavailable) return null
    if (parsedRevision !== snapshot.revision) { clearTimeout(timer); generation++; refresh(snapshot) }
    return parsed.value ? matchHeading(before, parsed.value.headings, heading.id) : null
  }
  return { parsed, state, width, active, reason, visible, compact, toggle, setTop, setActive, observeSourceLine, toggleOpen, close, resolveHeading }
}
