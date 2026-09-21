import { panelFits } from './panel-layout'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { HistoryEntry, OpenDocument, ScrollBookmark, SessionRef } from '../../../shared/contracts'
import { copy } from '../../../shared/copy'
import { HistoryPreviewController } from './history-preview'
import type { useWorkspace } from './use-workspace'

type Workspace = ReturnType<typeof useWorkspace>
const key = (document: { docId: string; epoch: string }) => `${document.docId}/${document.epoch}`
interface ListState { open: boolean; path: string | null; generation: number; top: number }
/** UI state only; every write remains in the original workspace/session actions. */
export function useHistory(ws: Workspace, beforeEnter: () => Promise<boolean>) {
  const open = ref(false); const compact = ref(!panelFits(window.innerWidth, 300))
  const entries = ref<HistoryEntry[]>([]); const loading = ref(false); const error = ref(''); const notice = ref(''); const working = ref(false)
  const signal = ref(0); const bookmark = ref<ScrollBookmark>({ top: 0, ratio: 0, revision: 0 })
  const positionSignal = ref(0)
  const states = new Map<string, ListState>(); let listSequence = 0; let entryIntent = 0; let activeKey = ''; let savedKey = ''; let switching = false
  const context = () => {
    const tab = ws.workspace.active && ws.workspace.getTab(ws.workspace.active)
    if (!tab) return null
    return { ref: tab.document, pathGeneration: states.get(key(tab.document))?.generation ?? 0, view: tab.view }
  }
  const controller = new HistoryPreviewController({ api: window.inknest, current: context, changed: () => signal.value++ })
  // Covers IME settlement before the controller can own an asynchronous body read.
  function invalidateEntry(): void { entryIntent++; controller.invalidate() }
  const preview = computed(() => { void signal.value; const state = controller.state; return state ? { ...state } : null })
  const displayed = computed<OpenDocument | null>(() => {
    const snapshot = preview.value?.snapshot; const document = ws.document.value
    return snapshot && document ? { ...document, text: snapshot.text, format: snapshot.format, readOnlyReason: snapshot.byteLength > 2 * 1024 * 1024 ? 'size' : null } : null
  })
  const restoreBlocked = computed(() => !ws.document.value?.displayPath || !ws.session.value || ws.editingFrozen.value || ws.tab.value?.diskStatus !== 'current' || ws.tab.value?.recoveryPending || !!ws.historyRestorePending.value)
  const top = computed(() => { void ws.signal.value; void positionSignal.value; return ws.document.value ? states.get(key(ws.document.value))?.top ?? 0 : 0 })
  function setTop(owner: SessionRef, value: number): void { const state = states.get(key(owner)); if (state && state.top !== value) { state.top = value; positionSignal.value++ } }
  function exit(): void {
    entryIntent++
    const owner = controller.state?.ref; const view = controller.exit()
    if (owner && view) ws.workspace.setView(owner, view)
    notice.value = ''
  }
  function close(): void { exit(); open.value = false }
  async function refresh(): Promise<void> {
    const current = context(); const sequence = ++listSequence
    entries.value = []; error.value = ''; loading.value = !!current
    if (!current) return
    if (!ws.document.value?.displayPath) { loading.value = false; return }
    try {
      const result = await window.inknest.listHistory({ docId: current.ref.docId, epoch: current.ref.epoch })
      const live = context()
      if (sequence !== listSequence || !live || key(live.ref) !== key(current.ref) || live.pathGeneration !== current.pathGeneration) return
      if (result.status === 'ok') {
        const tab = ws.workspace.getTab(current.ref)
        if (result.value.generation < (tab?.historyGeneration ?? 0)) return
        entries.value = result.value.entries
        controller.reconcileListing(new Set(entries.value.map(entry => entry.id)))
        if (controller.state && !controller.state.available) notice.value = copy.historyMerged
      }
      else if (result.status === 'error') error.value = result.error.message
    } catch { if (sequence === listSequence) error.value = copy.backupActionFailed }
    finally { if (sequence === listSequence) loading.value = false }
  }
  async function enter(id: string): Promise<void> {
    if (working.value || ws.frozen.value || ws.historyRestorePending.value) return
    const origin = context(); if (!origin) return
    const intent = ++entryIntent
    if (!await beforeEnter()) return
    const live = context(); if (intent !== entryIntent || working.value || ws.frozen.value || !live || key(live.ref) !== key(origin.ref) || live.pathGeneration !== origin.pathGeneration || ws.historyRestorePending.value) return
    bookmark.value = { top: 0, ratio: 0, revision: ws.document.value!.revision }; notice.value = ''
    const reading = controller.enter(origin.ref, id)
    await reading
  }
  async function restore(id?: string): Promise<void> {
    if (working.value || restoreBlocked.value) return
    if (id && controller.selectedId !== id) await enter(id)
    const state = controller.state; const target = state?.snapshot
    if (!state || (id && state.historyId !== id) || !target?.restorable || !state.available || restoreBlocked.value) return
    working.value = true
    try {
      const restored = await ws.restoreHistory(target)
      if (restored && controller.state === state) { exit(); ws.workspace.setView(state.ref, { mode: 'read' }); await refresh() }
    } finally { working.value = false }
  }
  async function exportSelected(): Promise<boolean> {
    const state = controller.state
    if (!state) return false
    if (!state.available) { notice.value = copy.historyMerged; return true }
    if (!state.snapshot || working.value || ws.frozen.value || ws.historyRestorePending.value) return true
    working.value = true; notice.value = ''
    try {
      const result = await window.inknest.exportHistory({ docId: state.ref.docId, epoch: state.ref.epoch }, state.historyId)
      if (controller.state === state) notice.value = result.status === 'ok' ? copy.exportDone : result.status === 'error' ? result.error.message : ''
    } catch { if (controller.state === state) notice.value = copy.backupActionFailed }
    finally { working.value = false }
    return true
  }
  async function retryResult(): Promise<void> {
    const pending = ws.historyRestorePending.value
    if (!pending || pending.retrying || working.value || ws.frozen.value) return
    working.value = true
    try { if (await ws.retryHistoryRestoreReceipt()) { ws.workspace.setView(pending.ref, { mode: 'read' }); if (open.value) await refresh() } }
    finally { working.value = false }
  }
  function cleaned(): void { exit(); if (open.value) void refresh() }
  watch(ws.signal, () => {
    const live = new Set(ws.workspace.refs.map(key))
    for (const id of states.keys()) if (!live.has(id)) states.delete(id)
    let migrated = false
    for (const ref of ws.workspace.refs) {
      const document = ws.workspace.get(ref)!; const id = key(ref); const state = states.get(id)
      if (!state) states.set(id, { open: false, path: document.displayPath, generation: 0, top: 0 })
      else if (state.path !== document.displayPath) { state.path = document.displayPath; state.generation++; state.top = 0; if (id === activeKey) migrated = true }
    }
    const id = ws.workspace.active ? key(ws.workspace.active) : ''
    const tab = ws.workspace.active && ws.workspace.getTab(ws.workspace.active)
    const saved = `${id}/${states.get(id)?.generation}/${tab?.document.diskToken}/${tab?.historyGeneration}`
    if (id !== activeKey || migrated) { invalidateEntry(); listSequence++; entries.value = []; notice.value = ''; activeKey = id; switching = true; open.value = states.get(id)?.open ?? false; switching = false }
    if (saved !== savedKey) { savedKey = saved; if (open.value) void refresh() }
  }, { flush: 'sync', immediate: true })
  watch(ws.historyRestorePending, pending => { if (pending) invalidateEntry() }, { flush: 'sync' })
  watch(open, value => { const state = states.get(activeKey); if (state) state.open = value; if (value && !switching) void refresh() }, { flush: 'sync' })
  const resize = () => { compact.value = !panelFits(window.innerWidth, 300) }
  window.addEventListener('resize', resize)
  onBeforeUnmount(() => { invalidateEntry(); listSequence++; window.removeEventListener('resize', resize) })
  return { open, compact, entries, loading, error, notice, working, preview, displayed, bookmark, restoreBlocked, top, setTop, enter, exit, close, refresh, restore, exportSelected, retryResult, cleaned }
}
