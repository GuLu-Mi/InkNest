<script setup lang="ts">
import { previewSearchSurface } from '../search/preview-search'
import type { SearchSurface } from '../search/search-model'
import ImageViewer from '../components/ImageViewer.vue'
import { resolveAnchor } from './anchor-map'
import { isLocalImageLink, linkGesture } from './link-actions'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { OpenDocument, ReadingAnchor, ScrollBookmark, SessionRef } from '../../../shared/contracts'
import { ReadingState } from './reading-state'
import { copy, resourceCopy } from '../../../shared/copy'
import { buildPreview } from './pipeline'
import { codeAction, enhancePreview } from './rich-content'
import { darkTheme } from '../theme'
import type { ParsedDocument, PreviewImage } from './document-model'
const props = defineProps<{ document: OpenDocument; bookmark: ScrollBookmark; parsed: ParsedDocument | null; sourceKey: string; interactive?: boolean }>()
const emit = defineEmits<{ searchSurface: [value: SearchSurface | null]; searchBlocked: [value: boolean]; bookmark: [ref: SessionRef, value: ScrollBookmark]; active: [key: string, id: string]; link: [target: string]; notice: [message: string] }>()
const host = ref<HTMLElement>()
let scrollHost: HTMLElement | null = null
let restored = false
let contentReady = false
let resizeObserver: ResizeObserver | null = null
let contentWidth = 0
let contentHeight = 0
let viewportHeight = 0
let anchorScrollTop = 0
let readingState: ReadingState | null = null
let pendingRestore: ScrollBookmark | null = props.bookmark
let renderedDocument = props.document
let visibleAnchor: ReadingAnchor | undefined
function measureLayout(): void {
  if (!host.value || !scrollHost) return
  const bounds = host.value.getBoundingClientRect()
  contentWidth = bounds.width; contentHeight = bounds.height
  viewportHeight = scrollHost.clientHeight; anchorScrollTop = scrollHost.scrollTop
}
function captureVisibleAnchor(): void {
  if (!scrollHost || !host.value) return
  visibleAnchor = readingState?.capture(scrollHost)
  measureLayout()
}
function restoreVisibleAnchor(force = false): void {
  if (!scrollHost || !host.value || !restored) return
  if (!force && contentWidth === host.value.getBoundingClientRect().width && contentHeight === host.value.getBoundingClientRect().height && viewportHeight === scrollHost.clientHeight) return
  if (pendingRestore) readingState?.restoreDisclosures(pendingRestore.disclosures ?? [])
  const anchor = visibleAnchor, target = anchor && readingState?.resolve(anchor)
  const rect = target?.getBoundingClientRect()
  if (anchor?.atStart) scrollHost.scrollTop = 0
  else if (anchor && rect && rect.height > 0) {
    scrollHost.scrollTop += rect.top - scrollHost.getBoundingClientRect().top - anchor.offset
  } else if (pendingRestore) {
    const max = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight)
    scrollHost.scrollTop = pendingRestore.revision === renderedDocument.revision ? pendingRestore.top : pendingRestore.ratio * max
  }
  // Keep the saved character through rich rendering and reflow. Intermediate
  // scroll clamping must not replace the bookmark with a provisional position.
  measureLayout()
  if (!visibleAnchor && !pendingRestore) captureVisibleAnchor()
  recordScroll()
}
function recordScroll(): void {
  if (!scrollHost || !restored || pendingRestore) return
  // ResizeObserver restores the cached pre-reflow anchor before a resize-driven
  // scroll event is allowed to replace it with a different visible character.
  if (host.value && (contentWidth !== host.value.getBoundingClientRect().width || contentHeight !== host.value.getBoundingClientRect().height || viewportHeight !== scrollHost.clientHeight)) return
  const max = scrollHost.scrollHeight - scrollHost.clientHeight
  if (!visibleAnchor || scrollHost.scrollTop !== anchorScrollTop) captureVisibleAnchor()
  updateActive()
  emit('bookmark', renderedDocument, { top: scrollHost.scrollTop, ratio: max > 0 ? scrollHost.scrollTop / max : 0, revision: renderedDocument.revision, ...(visibleAnchor ? { anchor: visibleAnchor } : {}), disclosures: readingState?.captureDisclosures() ?? [] })
}
function takeReadingControl(): void {
  if (!restored) return
  pendingRestore = null; captureVisibleAnchor()
}
function contentChanged(): void {
  searchReady()
  if (!pendingRestore) { captureVisibleAnchor(); recordScroll() }
}
function innerScroll(): void {
  if (!pendingRestore) { captureVisibleAnchor(); recordScroll() }
}
async function restoreScroll(): Promise<void> {
  const current = generation
  await nextTick()
  if (!scrollHost || current !== generation) return
  if (host.value) readingState = new ReadingState(host.value)
  visibleAnchor = pendingRestore?.anchor
  restored = true
  restoreVisibleAnchor(true)
  updateActive()
}
onMounted(() => {
  scrollHost = host.value?.closest<HTMLElement>('.document-stage') ?? null
  scrollHost?.addEventListener('scroll', recordScroll)
  scrollHost?.addEventListener('wheel', takeReadingControl, { passive: true })
  scrollHost?.addEventListener('pointerdown', takeReadingControl)
  scrollHost?.addEventListener('keydown', takeReadingControl)
  resizeObserver = new ResizeObserver(() => restoreVisibleAnchor())
  if (host.value) resizeObserver.observe(host.value)
  if (scrollHost) resizeObserver.observe(scrollHost)
  if (props.document.readOnlyReason === 'size') void restoreScroll().then(finishRestore)
})
const html = ref('')
const renderedVersion = ref(0)
const linkTargets = ref<string[]>([])
const gallery = ref<PreviewImage[]>([])
const viewer = ref<{ items: { url: string; label: string; target: string; loading: boolean }[]; index: number } | null>(null)
watch(viewer, value => emit('searchBlocked', !!value), { flush: 'sync' })
function searchReady(): void {
  const root = host.value?.querySelector<HTMLElement>('.plain-document,.preview')
  emit('searchSurface', root && !error.value ? previewSearchSurface(root, takeReadingControl, () => { captureVisibleAnchor(); recordScroll() }) : null)
}
let pendingAnchor: string | null = null
watch(() => props.sourceKey, () => { viewer.value = null; pendingAnchor = null })
const loading = ref(false)
const error = ref('')
let generation = 0
let enhancement: AbortController | null = null
let pendingHeading: { id: string; generation: number } | null = null
function enhance(current: number): void {
  enhancement?.abort(); enhancement = new AbortController()
  const signal = enhancement.signal
  const root = host.value?.querySelector<HTMLElement>('.preview')
  if (root && !error.value) void enhancePreview(root, darkTheme.value, signal, () => {
    if (current === generation) { searchReady(); restoreVisibleAnchor(true); updateActive() }
  }).finally(() => { if (current === generation && !signal.aborted) finishRestore() }).catch(() => { /* Cancelled work belongs to an older source or theme. */ })
}
function finishRestore(): void {
  if (!restored) return
  restoreVisibleAnchor(true)
  pendingRestore = null
  if (!visibleAnchor || !readingState?.resolve(visibleAnchor)) captureVisibleAnchor()
  recordScroll()
}
watch(darkTheme, () => { if (contentReady) enhance(generation) })
watch([() => props.parsed, () => props.document.displayPath], async () => {
  const current = ++generation
  pendingRestore = props.bookmark
  renderedDocument = props.document
  restored = false
  readingState = null
  enhancement?.abort()
  contentReady = false
  emit('searchSurface', null)
  viewer.value = null; linkTargets.value = []
  visibleAnchor = undefined
  pendingHeading = null
  if (props.document.readOnlyReason === 'size') { html.value = ''; loading.value = false; error.value = ''; await restoreScroll(); if (current === generation) { contentReady = true; searchReady(); finishRestore() }; return }
  if (!props.parsed) { html.value = ''; loading.value = true; return }
  const snapshot = props.document
  loading.value = true; error.value = ''
  try {
    const result = await buildPreview(props.parsed, snapshot, window.inknest)
    if (current === generation) {
      html.value = result.html; renderedVersion.value++; linkTargets.value = result.links ?? []; gallery.value = result.images ?? []
    }
  } catch { if (current === generation) error.value = copy.previewFailed }
  finally {
    if (current === generation) {
      loading.value = false; await restoreScroll()
      if (current === generation) {
        contentReady = true; searchReady(); finishNavigation(current)
        enhance(current)
      }
    }
  }
}, { immediate: true })
function updateActive(): void {
  if (!scrollHost || !host.value) return
  const headings = [...host.value.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')]
  const top = scrollHost.getBoundingClientRect().top + 32
  let active = headings[0]
  for (const heading of headings) { if (heading.getBoundingClientRect().top <= top) active = heading; else break }
  if (scrollHost.scrollHeight > scrollHost.clientHeight && scrollHost.scrollTop >= scrollHost.scrollHeight - scrollHost.clientHeight - 1) active = headings.at(-1)
  emit('active', props.sourceKey, active?.id ?? '')
}
function finishNavigation(current: number): void {
  if (pendingAnchor !== null && current === generation) { const fragment = pendingAnchor; pendingAnchor = null; revealAnchor(fragment) }
  const target = pendingHeading
  if (target && target.generation === generation && current === generation) revealHeading(target.id)
}
function revealHeading(id: string): void {
  if (!contentReady) { pendingHeading = { id, generation }; return }
  pendingHeading = null
  const heading = [...(host.value?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]') ?? [])].find(node => node.id === id)
  if (!heading || !scrollHost) return
  takeReadingControl()
  for (let details = heading.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true
  scrollHost.scrollTop += heading.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 24
  heading.focus({ preventScroll: true }); captureVisibleAnchor(); recordScroll()
  emit('active', props.sourceKey, id)
}
function revealAnchor(fragment: string): void {
  if (!contentReady || !props.parsed) { pendingAnchor = fragment; return }
  if (!fragment && scrollHost) { takeReadingControl(); scrollHost.scrollTop = 0; captureVisibleAnchor(); recordScroll(); return }
  const anchor = /^inknest-footnote-fn(?:ref)?\d+(?:-\d+)?$/u.test(fragment) ? { id: fragment } : resolveAnchor(props.parsed, fragment)
  if (!anchor) { emit('notice', '未找到对应章节'); return }
  const target = [...(host.value?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(node => node.id === anchor.id)
  if (!target || !scrollHost) { emit('notice', '未找到对应章节'); return }
  takeReadingControl()
  for (let details = target.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true
  scrollHost.scrollTop += target.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 24
  target.focus({ preventScroll: true }); captureVisibleAnchor(); recordScroll()
}
function openImage(url: string, label: string, target = ''): void {
  const items = gallery.value.map(item => ({ url: item.url, label: item.label, target: item.target, loading: !item.url && !item.failed }))
  let index = items.findIndex(item => item.url === url || (!!target && item.target === target))
  if (index < 0) { items.push({ url, label, target, loading: false }); index = items.length - 1 }
  else items[index] = { ...items[index]!, url, loading: false }
  viewer.value = { items, index }
}
let imageQueue = Promise.resolve()
function selectImage(index: number): void {
  const state = viewer.value; const item = state?.items[index]
  if (!state || !item) return
  state.index = index
  // Only resolve the visible image, serially: the main link route permits one
  // link open at a time. Rapid arrow presses must not permanently fail a page.
  imageQueue = imageQueue.then(async () => {
    if (viewer.value !== state || state.index !== index || item.url || !item.loading || !item.target) return
    const owner = props.document; const source = props.sourceKey
    try {
      const result = await window.inknest.openDocumentLink({ requestId: crypto.randomUUID(), ref: { docId: owner.docId, epoch: owner.epoch }, rawTarget: item.target })
      if (viewer.value !== state || props.sourceKey !== source) return
      if (result.status === 'ok' && result.value.kind === 'image') item.url = result.value.url
    } catch { /* Keep failures inside the viewer without disturbing the document. */ }
    finally { if (viewer.value === state) { item.loading = false; state.items = [...state.items] } }
  })
}
let pointerOrigin: { x: number; y: number } | null = null
let pointerDragged = false
function beginPointer(event: PointerEvent): void {
  pointerOrigin = event.button === 0 ? { x: event.clientX, y: event.clientY } : null
  pointerDragged = false
}
function trackPointer(event: PointerEvent): void {
  if (pointerOrigin && Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 4) pointerDragged = true
  if (event.type === 'pointerup' || event.type === 'pointercancel') pointerOrigin = null
}
function activateContent(event: MouseEvent | KeyboardEvent): void {
  if (!(event.target instanceof Element)) return
  if (event.target.closest('button[data-code-action]')) {
    const activate = event instanceof MouseEvent ? event.button === 0 && !pointerDragged : event.key === 'Enter' || event.key === ' '
    if (activate) { event.preventDefault(); void codeAction(event.target, message => emit('notice', message), contentChanged) }
    return
  }
  if (event instanceof MouseEvent && pointerDragged) { event.preventDefault(); return }
  const image = event.target.closest<HTMLImageElement>('img[src]')
  const anchor = event.target.closest<HTMLElement>('a[data-link-index]')
  const target = anchor ? linkTargets.value[Number(anchor.dataset.linkIndex)] : undefined
  const modified = linkGesture(event, /Mac/.test(navigator.platform))
  const plain = event instanceof KeyboardEvent ? (event.key === 'Enter' || event.key === ' ') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey : event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (target?.startsWith('#inknest-footnote-') && (plain || modified)) { event.preventDefault(); revealAnchor(target.slice(1)); return }
  if (!props.interactive) return
  if (image && target && isLocalImageLink(target) && plain) { event.preventDefault(); image.focus({ preventScroll: true }); emit('link', target); return }
  if (image && (plain || (modified && !target))) { event.preventDefault(); image.focus({ preventScroll: true }); openImage(image.src, image.alt || '图片'); return }
  if (anchor) event.preventDefault()
  if (target && (modified || (plain && isLocalImageLink(target)))) { anchor?.focus({ preventScroll: true }); emit('link', target) }
}
defineExpose({ recordScroll, revealHeading, revealAnchor, openImage })
onBeforeUnmount(() => {
  enhancement?.abort(); emit('searchSurface', null); viewer.value = null
  recordScroll()
  if (!pendingRestore) restoreVisibleAnchor(true)
  resizeObserver?.disconnect()
  visibleAnchor = undefined; readingState = null
  scrollHost?.removeEventListener('scroll', recordScroll)
  scrollHost?.removeEventListener('wheel', takeReadingControl)
  scrollHost?.removeEventListener('pointerdown', takeReadingControl)
  scrollHost?.removeEventListener('keydown', takeReadingControl)
  scrollHost = null; pendingHeading = null; generation++
})
function imageFailed(event: Event): void {
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  const placeholder = document.createElement('span')
  placeholder.dataset.searchIgnore = '';
  placeholder.textContent = `[${image.alt || copy.image}] ${resourceCopy.unavailable}`
  image.replaceWith(placeholder)
}
</script>
<template>
  <ImageViewer
    v-if="viewer"
    :items="viewer.items"
    :index="viewer.index"
    @close="viewer = null"
    @select="selectImage"
  />
  <section
    ref="host"
    class="reading-pane document-content"
    :aria-label="copy.documentBody"
    :aria-busy="loading"
  >
    <p
      v-if="loading"
      role="status"
    >
      {{ copy.previewLoading }}
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <pre
      v-if="document.readOnlyReason === 'size'"
      class="plain-document"
    >{{ document.text }}</pre>
    <!-- HTML only comes from the restricted sanitizer. -->
    <!-- eslint-disable vue/no-v-html -->
    <article
      v-else
      :key="renderedVersion"
      class="preview markdown-body"
      @error.capture="imageFailed"
      @pointerdown="beginPointer"
      @pointermove="trackPointer"
      @pointerup="trackPointer"
      @pointercancel="trackPointer"
      @click="activateContent"
      @keydown="activateContent"
      @toggle.capture="contentChanged"
      @scroll.capture="innerScroll"
      v-html="html"
    />
  </section>
</template>
