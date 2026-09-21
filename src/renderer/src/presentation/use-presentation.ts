import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import type { OpenDocument, PresentationRequest, ScrollBookmark, SessionRef, TabViewState } from '../../../shared/contracts'
import { copy } from '../../../shared/copy'
import type { useWorkspace } from '../documents/use-workspace'
import { OutlineState } from '../documents/outline-state'
import { parseDocument, type ParsedDocument } from '../preview/document-model'
const same = (a: SessionRef | null, b: SessionRef) => a?.docId === b.docId && a.epoch === b.epoch
/** Display-only snapshot; the workspace retains all writable state and scheduling. */
export function usePresentation(ws: ReturnType<typeof useWorkspace>, beforeEnter: () => Promise<boolean>, blocked: Ref<boolean>) {
  const snapshot = shallowRef<OpenDocument | null>(null); const parsed = shallowRef<ParsedDocument | null>(null)
  const restoring = ref(false)
  const active = ref(false); const pending = ref(false); const error = ref(''); const outlineOpen = ref(false)
  const outline = reactive(new OutlineState()); const activeHeading = ref('')
  const bookmark = ref<ScrollBookmark>({ top: 0, ratio: 0, revision: 0 })
  let saved: { ref: SessionRef; view: TabViewState; session: NonNullable<typeof ws.session.value> | null; editorScroll: NonNullable<typeof ws.session.value>['editorScroll'] } | null = null
  let request: PresentationRequest | null = null; let intent = 0; let disposed = false
  const entryForbidden = () => ws.busy.value || ws.editingFrozen.value || !!ws.historyRestorePending.value || ws.backupsOpen.value || blocked.value
  const activeForbidden = () => !!ws.historyRestorePending.value || ws.backupsOpen.value || blocked.value
  const invalidOwner = (owner: OpenDocument) => !same(ws.workspace.active, owner) || !ws.workspace.getTab(owner) || ws.workspace.getTab(owner)?.document.displayPath !== owner.displayPath
  const allowed = computed(() => !!ws.document.value && !entryForbidden() && !pending.value && !restoring.value && !snapshot.value)
  const sourceKey = computed(() => snapshot.value && request ? `presentation/${request.ref.docId}/${request.ref.epoch}/${request.requestId}` : '')
  function release(): void { const original = saved; saved = null; active.value = false; pending.value = false; snapshot.value = null; parsed.value = null; outlineOpen.value = false; outline.update([]); outline.top = 0; activeHeading.value = ''; if (original && ws.workspace.getTab(original.ref)) { if (original.editorScroll) original.session?.setEditorScroll(original.editorScroll); ws.workspace.setView(original.ref, original.view) } }
  async function enter(): Promise<void> {
    if (!allowed.value || disposed) return
    const origin = ws.tab.value!; const path = origin.document.displayPath; const token = ++intent
    pending.value = true; error.value = ''
    if (!await beforeEnter()) { if (token === intent) { pending.value = false; error.value = copy.compositionPending }; return }
    if (token !== intent || disposed || ws.tab.value !== origin || origin.document.displayPath !== path || entryForbidden()) { if (token === intent) pending.value = false; return }
    const document = ws.document.value!
    saved = { ref: { docId: document.docId, epoch: document.epoch }, view: { ...origin.view, reading: { ...origin.view.reading } }, session: origin.session, editorScroll: origin.session?.editorScroll }
    snapshot.value = { ...document, format: document.format ? { ...document.format } : null }
    bookmark.value = { top: 0, ratio: 0, revision: document.revision }
    try { parsed.value = document.readOnlyReason === 'size' ? null : parseDocument(document.text); outline.update(parsed.value?.headings ?? []) }
    catch { release(); error.value = copy.previewFailed; return }
    const entering = request = { requestId: crypto.randomUUID(), ref: { docId: document.docId, epoch: document.epoch }, enabled: true }
    try {
      const result = await window.inknest.setPresentation(entering)
      if (request !== entering || disposed) return
      if (result.status !== 'ok') { release(); error.value = result.status === 'error' ? result.error.message : ''; request = null }
    } catch {
      if (request === entering && !disposed) { error.value = copy.presentationFailed; await exit() }
    }
  }
  async function exit(): Promise<void> {
    intent++
    const previous = request; request = null; release()
    if (!previous) return
    restoring.value = true
    const exiting = request = { ...previous, requestId: crypto.randomUUID(), enabled: false }
    try { const result = await window.inknest.setPresentation(exiting); if (request === exiting && result.status !== 'ok') restoring.value = false } catch { restoring.value = false }
  }
  const unsubscribe = window.inknest.onEvent(event => {
    if (event.type !== 'presentation-state' || !request || event.requestId !== request.requestId || !same(event.ref, request.ref)) return
    if (event.enabled) {
      if (!request.enabled || !snapshot.value || !event.fullscreen) return
      // Recheck the live gate at receipt time, independently of watcher scheduling.
      if (invalidOwner(snapshot.value) || (active.value ? activeForbidden() : entryForbidden())) { void exit(); return }
      active.value = true; pending.value = false
    } else {
      restoring.value = false
      const failed = request.enabled && pending.value
      release(); request = null
      if (failed) error.value = copy.presentationFailed
    }
  })
  watch([() => { const doc = ws.document.value; return doc ? `${doc.docId}/${doc.epoch}/${doc.displayPath}` : '' }, blocked, ws.backupsOpen, ws.historyRestorePending, ws.busy, ws.editingFrozen], () => {
    const owner = snapshot.value
    if (owner && (invalidOwner(owner) || blocked.value || ws.historyRestorePending.value || ws.backupsOpen.value || pending.value && entryForbidden())) void exit()
    else if (!owner && pending.value) { intent++; pending.value = false }
  }, { flush: 'sync' })
  onBeforeUnmount(() => { disposed = true; unsubscribe(); void exit() })
  return { snapshot, parsed, restoring, active, pending, allowed, error, sourceKey, outlineOpen, outline, activeHeading, bookmark, enter, exit }
}
