<script setup lang="ts">
import SearchBar from './components/SearchBar.vue'
import { useDocumentSearch, type FindCommand } from './search/use-document-search'
import type { SearchSurface } from './search/search-model'
import { resolveAnchor } from './preview/anchor-map'
import { OUTLINE_WIDTH, panelFits, panelLayout } from './documents/panel-layout'
import PresentationView from './presentation/PresentationView.vue'
import { usePresentation } from './presentation/use-presentation'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, watchEffect } from 'vue'
import type { SessionRef } from '../../shared/contracts'
import type { HeadingEntry } from './preview/document-model'
import DocumentOutline from './components/DocumentOutline.vue'
import { useOutline } from './documents/use-outline'
import { copy, readOnlyCopy } from '../../shared/copy'
import DocumentToolbar from './components/DocumentToolbar.vue'
import WelcomePage from './components/WelcomePage.vue'
import { useWorkspace } from './documents/use-workspace'
import EditorPane from './editor/EditorPane.vue'
import PreviewPane from './preview/PreviewPane.vue'
import BackupManagerDialog from './components/BackupManagerDialog.vue'
import HistorySidebar from './components/HistorySidebar.vue'
import HistoryPreviewBar from './components/HistoryPreviewBar.vue'
import { useHistory } from './documents/use-history'
import DocumentIssues from './components/DocumentIssues.vue'
import DocumentTabs from './components/DocumentTabs.vue'
import ToastNotice from './components/ToastNotice.vue'
const editor = ref<InstanceType<typeof EditorPane>>()
const ws = useWorkspace(editor, { canCreate: () => !presenting.value && !presentationPending.value && !backupsOpen.value && !historyWorking.value,  saveAs: () => history.exportSelected(), presentation: () => presentation.enter(), find: searchCommand })
const { createDocument, retryRecovery, backupsOpen, signal, workspace, tabs, tab, document, session, dirty, mode, busy, frozen, editingFrozen, historyRestorePending, error, activate, closeDocument, setMode, openFile, save, saveAs, canSaveAs, resolveConflict } = ws
const previewPane = ref<InstanceType<typeof PreviewPane>>()
const history = useHistory(ws, async () => { if (await editor.value?.settleComposition() === false) return false; previewPane.value?.recordScroll(); return true })
const { open: historyOpen, compact: historyCompact, entries, loading: historyLoading, error: historyError, notice: historyNotice, working: historyWorking, preview: historical, displayed: historicalDocument, bookmark: historicalBookmark, restoreBlocked, top: historyTop } = history
const presentationBlocked = computed(() => !!historical.value || historyWorking.value)
const presentation = usePresentation(ws, async () => { if (await editor.value?.settleComposition() === false) return false; previewPane.value?.recordScroll(); editor.value?.recordView(); return true }, presentationBlocked)
const { active: presenting, pending: presentationPending, error: presentationError, allowed: presentationAllowed } = presentation
const composing = ref(false)
const sourceKey = computed(() => historical.value ? `history/${document.value?.epoch}/${historical.value.historyId}` : document.value ? `current/${document.value.docId}/${document.value.epoch}` : '')
const outlineSource = computed(() => { const displayed = historical.value ? historicalDocument.value : document.value; return displayed ? { key: sourceKey.value, text: displayed.text, revision: displayed.revision, unavailable: displayed.readOnlyReason === 'size' } : null })
const searchSurface = shallowRef<SearchSurface | null>(null), imageOpen = ref(false)
const presentationView = ref<InstanceType<typeof PresentationView>>()
const searchSource = computed(() => {
  const displayed = historical.value ? historicalDocument.value : document.value
  if (!displayed || presenting.value) return null
  return { key: `${sourceKey.value}/${historical.value ? 'read' : mode.value}`, stateKey: historical.value ? `history/${document.value?.docId}/${document.value?.epoch}` : sourceKey.value, version: displayed.revision, label: historical.value ? '搜索历史版本' : mode.value === 'edit' ? '搜索 Markdown 源码' : '搜索文档正文' }
})
const searchKeys = computed(() => [...tabs.value.map(t => `current/${t.document.docId}/${t.document.epoch}`), ...(historical.value ? [`history/${document.value?.docId}/${document.value?.epoch}`] : [])])
const search = useDocumentSearch(searchSource, searchSurface, computed(() => backupsOpen.value || frozen.value || imageOpen.value || presentationPending.value), searchKeys, async () => await editor.value?.settleComposition() !== false)
async function searchCommand(command: FindCommand): Promise<void> { if (presenting.value) await presentationView.value?.searchCommand(command); else await search.command(command) }
const liveOutlineKeys = computed(() => tabs.value.map(tab => `current/${tab.document.docId}/${tab.document.epoch}`))
const outline = useOutline(outlineSource, composing, historyOpen, liveOutlineKeys, computed(() => presentationPending.value || presentation.restoring.value || !!presentation.snapshot.value), computed(() => document.value ? `current/${document.value.docId}/${document.value.epoch}` : ''))
const { parsed, state: outlineState, active: activeHeading, visible: outlineVisible, compact: outlineCompact, reason: outlineReason } = outline
const sharingSpace = computed(() => !panelFits(outline.width.value, Math.max(outlineVisible.value ? OUTLINE_WIDTH : 0, historyOpen.value ? 300 : 0)))
const panelStyle = computed(() => {
  const layout = panelLayout(outline.width.value, outlineVisible.value, historyOpen.value)
  return { '--panel-left': `${layout.left}px`, '--panel-right': `${layout.right}px`, '--content-left': `${layout.contentLeft}px`, '--content-right': `${layout.contentRight}px`, '--outline-width': `${layout.outlineWidth}px`, '--history-width': `${layout.historyWidth}px` }
})
watch(sourceKey, () => { composing.value = false }, { flush: 'sync' })
function compositionChanged(owner: SessionRef, value: boolean): void { if (document.value?.docId === owner.docId && document.value.epoch === owner.epoch) composing.value = value }
function sourceLineChanged(owner: SessionRef, line: number): void {
  if (document.value?.docId !== owner.docId || document.value.epoch !== owner.epoch || historical.value) return
  outline.observeSourceLine(sourceKey.value, line)
}
async function closeOutline(): Promise<void> { outline.close(); await nextTick(); window.document.querySelector<HTMLButtonElement>('.outline-trigger')?.focus() }
async function navigateHeading(heading: HeadingEntry): Promise<void> {
  const key = sourceKey.value; const origin = outlineState.value.headings
  if (await editor.value?.settleComposition() === false || key !== sourceKey.value) return
  const target = outline.resolveHeading(heading, origin); if (!target) return
  await nextTick()
  if (key !== sourceKey.value) return
  if (editor.value && !historical.value) editor.value.revealSourceLine(target.sourceLine)
  else previewPane.value?.revealHeading(target.id)
  outline.setActive(key, target.id)
}
const linkNotice = ref<{ message: string; sequence: number } | null>(null)
let noticeSequence = 0
function showLinkNotice(message: string): void { linkNotice.value = { message, sequence: ++noticeSequence } }
let linkIntent = 0
let linkSourceGeneration = 0
watch([sourceKey, () => document.value?.displayPath], () => { linkSourceGeneration++ }, { flush: 'sync' })
const linkedAnchor = ref<{ docId: string; epoch: string; fragment: string } | null>(null)
async function openLink(rawTarget: string): Promise<void> {
  const origin = sourceKey.value; const sourceGeneration = linkSourceGeneration; const revision = document.value?.revision; const intent = ++linkIntent
  linkNotice.value = null
  const result = await ws.openLinked(rawTarget, () => sourceKey.value === origin && sourceGeneration === linkSourceGeneration && document.value?.revision === revision && intent === linkIntent && !presenting.value)
  if (intent !== linkIntent) return
  if (result.status === 'error') { showLinkNotice(result.error.message); return }
  if (result.status !== 'ok') return
  if (result.value.kind === 'document') {
    const value = result.value
    if (value.fragment) linkedAnchor.value = { docId: value.document.docId, epoch: value.document.epoch, fragment: value.fragment }
  } else if (result.value.kind === 'anchor') previewPane.value?.revealAnchor(result.value.fragment)
  else if (result.value.kind === 'image') previewPane.value?.openImage(result.value.url, result.value.label, rawTarget)
}
watch([linkedAnchor, parsed, document, mode], async () => {
  const target = linkedAnchor.value
  if (!target || !document.value || !parsed.value) return
  if (target.docId !== document.value.docId || target.epoch !== document.value.epoch) { linkedAnchor.value = null; return }
  linkedAnchor.value = null
  await nextTick()
  if (mode.value === 'edit' && editor.value) {
    const anchor = resolveAnchor(parsed.value, target.fragment)
    if (anchor) editor.value.revealSourceLine(anchor.sourceLine); else showLinkNotice('未找到对应章节')
  } else previewPane.value?.revealAnchor(target.fragment)
}, { flush: 'post' })
watch(sourceKey, () => { linkNotice.value = null })
const recoveryCount = ref(0); const recoveryDismissed = ref(false); const backupError = ref('')
watch(() => !document.value, welcome => { if (welcome) { recoveryCount.value = 0; recoveryDismissed.value = false } }, { flush: 'sync' })
async function exitHistory(close = false): Promise<void> { if (close) history.close(); else history.exit(); await nextTick(); window.document.querySelector<HTMLButtonElement>('.document-toolbar button:last-child')?.focus() }
async function surfaceSaveAs(): Promise<void> { if (!await history.exportSelected()) await saveAs() }
const historyReason = computed(() => historical.value && !historical.value.available ? copy.historyMerged : restoreBlocked.value ? copy.historyRestoreBlocked : historical.value?.snapshot && !historical.value.snapshot.restorable ? copy.historyNotRestorable : '')
const status = computed(() => {
  void signal.value
  if (document.value?.readOnlyReason) return readOnlyCopy[document.value.readOnlyReason]
  const state = tab.value
  const primary = state?.saving ? copy.saving : (state?.diskStatus !== 'current' || state?.saveFailure) ? copy.saveFailed : !document.value?.displayPath ? copy.unsavedFile : dirty.value ? copy.pending : copy.saved
  return [primary, state?.recoveryPending ? copy.recoveryPending : '', state?.recoveryStatus === 'backed-up' ? copy.recoveryBackedUp : state?.recoveryStatus === 'pending' ? copy.recoveryWaiting : state?.recoveryStatus === 'error' ? copy.recoveryError : '', frozen.value ? copy.processing : '', state?.notice].filter(Boolean).join(' · ')
})
const hasNotices = computed(() => { void signal.value; return !!historyRestorePending.value || !!backupError.value || (recoveryCount.value > 0 && !recoveryDismissed.value) || !!tab.value?.historyAttention || !!tab.value?.historyMaintenance || !!tab.value?.recoveryError || !!error.value || (!!tab.value && tab.value.diskStatus !== 'current') })
const isMac = /Mac/.test(navigator.platform)
async function activateTab(ref: SessionRef, keyboard = false): Promise<void> {
  await activate(ref)
  await nextTick()
  if (keyboard && workspace.active?.docId === ref.docId && workspace.active.epoch === ref.epoch) {
    window.document.querySelector<HTMLButtonElement>('.document-tabs [aria-selected="true"]')?.focus()
  }
}
async function openHome(): Promise<void> {
  if (!await ws.showHome()) return
  await nextTick()
  window.document.querySelector<HTMLButtonElement>('.welcome-open')?.focus()
}
watchEffect(() => { window.document.title = document.value ? `${dirty.value ? '* ' : ''}${document.value.displayName} · InkNest` : 'InkNest' })
watch(presenting, async (value, before) => { if (before && !value) { await nextTick(); window.document.querySelector<HTMLButtonElement>('.presentation-trigger')?.focus() } })
function preventUnload(event: BeforeUnloadEvent): void { if (workspace.refs.length) { event.preventDefault(); event.returnValue = '' } }
function saveShortcut(event: KeyboardEvent): void {
  if (presentationPending.value && event.key === 'Escape') { event.preventDefault(); void presentation.exit(); return }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void openFile(); return }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') { event.preventDefault(); if (workspace.active) void closeDocument(workspace.active); return }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void (event.shiftKey ? surfaceSaveAs() : save()) }
}
window.addEventListener('keydown', saveShortcut)
window.addEventListener('beforeunload', preventUnload)
onBeforeUnmount(() => { window.removeEventListener('beforeunload', preventUnload); window.removeEventListener('keydown', saveShortcut) })
</script>
<template>
  <div
    class="shell"
    :class="{ 'mac-titlebar': isMac }"
  >
    <PresentationView
      v-if="presenting"
      ref="presentationView"
      :presentation="presentation"
      :notice="hasNotices"
    />
    <template v-else>
      <header :aria-label="copy.titlebar">
        <DocumentTabs
          :tabs="tabs"
          :active="workspace.active"
          :disabled="frozen"
          :busy="busy || editingFrozen || presentationPending || backupsOpen || historyWorking"
          @activate="activateTab"
          @close="closeDocument"
          @home="openHome"
        >
          <button
            v-if="document"
            type="button"
            class="quick-save"
            :aria-label="copy.save"
            :title="`${copy.save}（${isMac ? '⌘S' : 'Ctrl+S'}）`"
            :disabled="!session || editingFrozen || busy || presentationPending || historyWorking || !!historical"
            @click="save"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8M14 4v3" />
            </svg>
          </button>
          <button
            v-if="!document && recoveryCount > 0"
            class="welcome-recovery"
            @click="backupsOpen = true"
          >
            {{ copy.restoreDocuments }}
          </button>
        </DocumentTabs>
      </header>
      <ToastNotice :notice="linkNotice" />
      <div
        class="document-notices"
        :role="hasNotices ? 'region' : undefined"
        :aria-label="hasNotices ? copy.notices : undefined"
        :tabindex="hasNotices ? 0 : undefined"
      >
        <p
          v-if="tab?.historyMaintenance"
          class="compact-notice"
          role="status"
        >
          {{ copy.historyCleanupFailed }}
        </p>
        <div
          v-if="tab?.historyAttention"
          class="compact-notice"
          role="alert"
        >
          <span>{{ tab.historyAttention.state === 'skipped' ? copy.historySkipped : copy.historySavedFailed }}</span>
          <button
            :disabled="editingFrozen"
            @click="save"
          >
            {{ copy.retry }}
          </button>
        </div>
        <div
          v-if="presentationPending"
          class="compact-notice"
          role="status"
        >
          <span>正在进入全屏演示…</span><button @click="presentation.exit">
            {{ copy.cancel }}
          </button>
        </div>
        <p
          v-if="presentationError"
          class="error-banner"
          role="alert"
        >
          {{ presentationError }}
        </p>
        <div
          v-if="recoveryCount && !recoveryDismissed"
          class="compact-notice"
          role="status"
        >
          <span>{{ copy.recoveryFound(recoveryCount) }}</span><button @click="backupsOpen = true">
            {{ copy.view }}
          </button><button
            :aria-label="copy.dismiss"
            @click="recoveryDismissed = true"
          >
            ×
          </button>
        </div>
        <div
          v-if="backupError"
          class="error-banner"
          role="alert"
        >
          <span>{{ backupError }}</span><button @click="backupsOpen = true">
            {{ copy.backups }}
          </button>
        </div>
        <div
          v-if="historyRestorePending"
          class="compact-notice"
          role="status"
        >
          <span>{{ copy.historyPending }}</span><button
            :disabled="historyRestorePending.retrying || frozen"
            @click="history.retryResult"
          >
            {{ historyRestorePending.retrying ? copy.historyResultChecking : copy.historyResultCheck }}
          </button>
        </div>
        <div
          v-if="tab?.recoveryError"
          class="error-banner"
          role="alert"
        >
          <span>{{ tab.recoveryError }}</span>
          <button
            type="button"
            :disabled="frozen"
            @click="backupsOpen = true"
          >
            {{ copy.backups }}
          </button>
          <button
            v-if="dirty || !document?.displayPath"
            type="button"
            :disabled="frozen"
            @click="retryRecovery"
          >
            {{ copy.retry }}
          </button>
        </div>
        <div
          v-if="error"
          class="error-banner"
          role="alert"
        >
          <span>{{ error }}</span>
          <button
            v-if="tab?.saveFailure && tab.diskStatus === 'current' && session"
            type="button"
            :disabled="frozen"
            @click="save"
          >
            {{ copy.retry }}
          </button>
          <button
            v-if="tab?.saveFailure && canSaveAs"
            type="button"
            :disabled="frozen"
            @click="saveAs"
          >
            {{ copy.saveAs }}
          </button>
        </div>
        <DocumentIssues
          v-if="tab && tab.diskStatus !== 'current'"
          :status="tab.diskStatus"
          :inspection="tab.inspection"
          :disabled="frozen"
          :can-inspect="!!session"
          :can-save-copy="canSaveAs"
          @resolve="resolveConflict"
        />
      </div>
      <div
        v-if="document"
        class="document-workspace"
        :style="panelStyle"
        :class="{ 'panels-sharing-space': sharingSpace }"
      >
        <DocumentOutline
          v-if="outlineVisible"
          :key="sourceKey + String(outlineCompact)"
          :source-key="sourceKey"
          :state="outlineState"
          :active="activeHeading"
          :compact="outlineCompact"
          :reason="outlineReason"
          @navigate="navigateHeading"
          @toggle="outline.toggle"
          @close="closeOutline"
          @scroll="outline.setTop"
        />
        <div class="document-center">
          <div
            class="document-toolbar-row"
            :class="{ 'is-history': !!historical }"
          >
            <HistoryPreviewBar
              v-if="historical"
              :saved-at="historical.snapshot?.savedAt ?? null"
              :loading="historical.loading"
              :disabled="historyWorking || frozen || !historical?.available"
              :reason="historyReason"
              :notice="historyNotice"
              :outline-open="outlineVisible"
              :history-open="historyOpen"
              @history="historyOpen = !historyOpen"
              @outline="outline.toggleOpen"
              @exit="exitHistory()"
              @export="history.exportSelected"
            />
            <DocumentToolbar
              v-else
              :mode="mode"
              :editable="!!session"
              :disabled="editingFrozen || presentationPending"
              :presentation-disabled="!presentationAllowed"
              :history-open="historyOpen"
              :outline-open="outlineVisible"
              @presentation="presentation.enter"
              @outline="outline.toggleOpen"
              @mode="setMode"
              @history="historyOpen ? exitHistory(true) : historyOpen = true"
            />
            <SearchBar
              v-if="search.visible.value"
              :key="searchSource?.key ?? ''"
              :query="search.state.value.query"
              :case-sensitive="search.state.value.caseSensitive"
              :status="search.status.value"
              :notice="search.wrap.value"
              :label="searchSource?.label ?? '搜索文档正文'"
              :can-navigate="search.canNavigate.value"
              :focus-request="search.focusRequest.value"
              :replace-enabled="!historical && mode === 'edit' && !!session"
              :replacement="search.state.value.replacement"
              :can-replace="search.canReplace.value"
              :replacing="search.replacing.value"
              :replace-notice="search.replaceNotice.value"
              @replacement="search.setReplacement"
              @replace="search.replace"
              @query="search.setQuery"
              @toggle-case="search.toggleCase"
              @navigate="search.move"
              @close="search.close"
              @composing="search.composing.value = $event"
            />
          </div>
          <div class="search-stage">
            <main
              class="document-stage"
              :class="{ 'edit-stage': !historical && mode === 'edit' }"
            >
              <div
                v-if="historical && !historicalDocument"
                class="history-message document-content"
                :role="historical.error ? 'alert' : 'status'"
              >
                <p>{{ historical.error?.message || copy.historyLoading }}</p><button
                  v-if="historical.error"
                  :disabled="historyWorking || frozen || !historical?.available"
                  @click="history.enter(historical.historyId)"
                >
                  {{ copy.retry }}
                </button>
              </div>
              <PreviewPane
                v-else-if="historicalDocument"
                :key="'history/' + historical!.historyId"
                ref="previewPane"
                :interactive="true"
                :document="historicalDocument"
                :parsed="parsed"
                :source-key="sourceKey"
                :bookmark="historicalBookmark"
                @search-surface="searchSurface = $event"
                @search-blocked="imageOpen = $event"
                @link="openLink"
                @notice="showLinkNotice"
                @active="outline.setActive"
                @bookmark="(_ref, value) => historicalBookmark = value"
              />
              <EditorPane
                v-else-if="session && mode === 'edit'"
                :key="document.epoch"
                ref="editor"
                :session="session"
                :editor-top="tab!.view.editorTop"
                @search-surface="searchSurface = $event"
                @composition="compositionChanged"
                @line="sourceLineChanged"
                @scroll="(ref, top) => workspace.setView(ref, { editorTop: top })"
              />
              <PreviewPane
                v-else
                :key="'current/' + document.epoch"
                ref="previewPane"
                :interactive="true"
                :document="document"
                :parsed="parsed"
                :source-key="sourceKey"
                :bookmark="tab!.view.reading"
                @search-surface="searchSurface = $event"
                @search-blocked="imageOpen = $event"
                @link="openLink"
                @notice="showLinkNotice"
                @active="outline.setActive"
                @bookmark="(ref, bookmark) => workspace.setView(ref, { reading: bookmark })"
              />
            </main>
          </div>
        </div>
        <HistorySidebar
          v-if="historyOpen"
          :key="String(historyCompact) + document.epoch"
          :owner="document"
          :entries="entries"
          :selected="historical?.historyId ?? null"
          :loading="historyLoading"
          :error="historyError"
          :disabled="historyWorking || frozen || !!historyRestorePending"
          :restore-blocked="restoreBlocked"
          :compact="historyCompact"
          :top="historyTop"
          :status="status"
          @preview="history.enter"
          @restore="history.restore"
          @close="exitHistory(true)"
          @current="exitHistory()"
          @retry="history.refresh"
          @scroll="history.setTop"
        />
      </div>
      <WelcomePage
        v-else
        :busy="busy"
        :disabled="frozen"
        @open="openFile"
        @create="createDocument"
      />
      <footer
        v-if="document && !historical"
        class="document-status-bar"
      >
        <p
          class="document-status"
          role="status"
          :title="status"
        >
          {{ status }}
        </p>
      </footer>
    </template>
    <BackupManagerDialog
      :open="backupsOpen"
      :welcome="!document"
      :disabled="frozen"
      @close="backupsOpen = false"
      @found="recoveryCount = $event"
      @failure="backupError = $event"
      @cleaned="history.cleaned"
    />
  </div>
</template>
