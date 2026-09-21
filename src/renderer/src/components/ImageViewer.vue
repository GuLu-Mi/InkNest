<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { imageViewerCopy as copy } from '../../../shared/image-viewer-copy'
import { fitImageScale, imageViewerUrl, nextImageIndex, zoomImageScale, viewerNavigationDirection, imageViewerLoadStatus, isImageZoomWheel, imageWheelDelta, wheelImageScale, nextImageRotation, rotatedImageSize, rotateImagePoint, unrotateImagePoint, IMAGE_VIEWER_PADDING, MAX_IMAGE_SCALE, type ImageRotation, type ImagePoint, type ViewerImage } from '../preview/image-viewer'
import './image-viewer.css'

const props = defineProps<{ items: readonly ViewerImage[]; index: number }>()
const emit = defineEmits<{ close: []; select: [index: number] }>()
const dialog = ref<HTMLDialogElement>()
const viewport = ref<HTMLElement>()
const frame = ref<HTMLElement>()
const image = ref<HTMLImageElement>()
const currentIndex = ref(0)
const current = computed(() => props.items[currentIndex.value])
const source = computed(() => current.value ? imageViewerUrl(current.value.url) : null)
const scale = ref(1)
const width = ref(0)
const height = ref(0)
const fit = ref(true)
const rotation = ref<ImageRotation>(0)
const viewportSize = ref({ width: 0, height: 0 })
const orientedSize = computed(() => rotatedImageSize(width.value, height.value, rotation.value))
const fitScale = computed(() => fitImageScale(orientedSize.value.width, orientedSize.value.height, viewportSize.value.width - IMAGE_VIEWER_PADDING * 2, viewportSize.value.height - IMAGE_VIEWER_PADDING * 2))
const minimumScale = computed(() => Math.min(0.1, fitScale.value))
const isMac = /Mac/.test(navigator.platform)
const hint = isMac ? copy.zoomHintMac : copy.zoomHintWindows
const announcement = ref('')
const status = ref<'loading' | 'ready' | 'error'>('loading')
const generation = ref(0)
let observer: ResizeObserver | undefined
let origin: HTMLElement | null = null
let previousOverflow = ''
let mounted = false
let closing = false
interface ViewAnchor { point: ImagePoint; client: ImagePoint }
let pendingZoom: { scale: number; anchor: ViewAnchor | null } | null = null
let zoomFrame: number | undefined
let viewRevision = 0
let announcementTimer: ReturnType<typeof setTimeout> | undefined

function cancelViewUpdate(): void {
  viewRevision++
  if (zoomFrame !== undefined) cancelAnimationFrame(zoomFrame)
  zoomFrame = undefined
  pendingZoom = null
}
function announce(): void {
  clearTimeout(announcementTimer)
  announcementTimer = setTimeout(() => {
    if (!closing && status.value === 'ready') announcement.value = `${Math.round(scale.value * 100)}%，${copy.rotationStatus} ${rotation.value}°`
  }, 200)
}
function measureViewport(): void {
  if (viewport.value) viewportSize.value = { width: viewport.value.clientWidth, height: viewport.value.clientHeight }
}
function captureAnchor(client?: ImagePoint): ViewAnchor | null {
  if (!frame.value || !viewport.value || status.value !== 'ready') return null
  const rect = frame.value.getBoundingClientRect()
  const view = viewport.value.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  // Use the visible image center when the pointer is over its surrounding space.
  const visibleCenter = {
    x: (Math.max(rect.left, view.left + viewport.value.clientLeft) + Math.min(rect.right, view.left + viewport.value.clientLeft + viewport.value.clientWidth)) / 2,
    y: (Math.max(rect.top, view.top) + Math.min(rect.bottom, view.top + viewport.value.clientHeight)) / 2
  }
  const target = client && client.x >= rect.left && client.x <= rect.right && client.y >= rect.top && client.y <= rect.bottom ? client : visibleCenter
  const point = { x: Math.max(0, Math.min(1, (target.x - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (target.y - rect.top) / rect.height)) }
  return { point: unrotateImagePoint(point, rotation.value), client: target }
}
function applyView(nextScale: number, nextRotation: ImageRotation, nextFit: boolean, anchor: ViewAnchor | null): void {
  cancelViewUpdate()
  const revision = viewRevision
  scale.value = nextScale; rotation.value = nextRotation; fit.value = nextFit
  void nextTick(() => {
    if (closing || revision !== viewRevision || !viewport.value || !frame.value) return
    if (nextFit) resetScroll()
    else if (anchor) {
      const rect = frame.value.getBoundingClientRect()
      const point = rotateImagePoint(anchor.point, nextRotation)
      viewport.value.scrollLeft += rect.left + rect.width * point.x - anchor.client.x
      viewport.value.scrollTop += rect.top + rect.height * point.y - anchor.client.y
    }
  })
  announce()
}
function wheel(event: WheelEvent): void {
  event.stopPropagation()
  if (!isImageZoomWheel(event, isMac)) return
  event.preventDefault()
  if (closing || status.value !== 'ready' || !(event.target instanceof Node) || !viewport.value?.contains(event.target)) return
  const delta = imageWheelDelta(event.deltaY, event.deltaMode, viewport.value.clientHeight)
  if (!delta) return
  const previous = pendingZoom?.scale ?? scale.value
  const next = wheelImageScale(previous, delta, fitScale.value)
  if (next === previous) return
  pendingZoom = { scale: next, anchor: pendingZoom?.anchor ?? captureAnchor({ x: event.clientX, y: event.clientY }) }
  if (zoomFrame !== undefined) return
  zoomFrame = requestAnimationFrame(() => {
    const pending = pendingZoom
    zoomFrame = undefined; pendingZoom = null
    if (pending && pending.scale !== scale.value && !closing && status.value === 'ready') applyView(pending.scale, rotation.value, false, pending.anchor)
  })
}

function close(): void {
  if (closing) return
  closing = true
  cancelViewUpdate()
  clearTimeout(announcementTimer)
  emit('close')
}
function resetScroll(): void {
  if (viewport.value) { viewport.value.scrollTop = 0; viewport.value.scrollLeft = 0 }
}
function fitToViewport(): void {
  if (status.value !== 'ready') return
  measureViewport()
  applyView(fitScale.value, rotation.value, true, null)
}
function resetImage(): void {
  cancelViewUpdate()
  clearTimeout(announcementTimer)
  announcement.value = ''
  generation.value++
  width.value = 0; height.value = 0; scale.value = 1; fit.value = true; rotation.value = 0
  status.value = imageViewerLoadStatus(current.value)
  const revision = viewRevision
  void nextTick(() => { if (revision === viewRevision && !closing) resetScroll() })
}
function load(event: Event): void {
  const target = event.target as HTMLImageElement
  // A removed image may still dispatch its decode result after navigation.
  if (target !== image.value || target.dataset.generation !== String(generation.value)) return
  if (!target.naturalWidth || !target.naturalHeight) { status.value = 'error'; return }
  width.value = target.naturalWidth; height.value = target.naturalHeight
  status.value = 'ready'
  fitToViewport()
}
function fail(event: Event): void {
  if (event.target === image.value) { cancelViewUpdate(); clearTimeout(announcementTimer); status.value = 'error' }
}
function zoom(direction: -1 | 1): void {
  if (status.value !== 'ready') return
  const next = zoomImageScale(scale.value, direction, fitScale.value)
  if (next !== scale.value) applyView(next, rotation.value, false, captureAnchor())
}
function originalSize(): void {
  if (status.value === 'ready') applyView(1, rotation.value, false, captureAnchor())
}
function rotate(): void {
  if (status.value !== 'ready') return
  const next = nextImageRotation(rotation.value)
  const size = rotatedImageSize(width.value, height.value, next)
  const nextScale = fit.value ? fitImageScale(size.width, size.height, viewportSize.value.width - IMAGE_VIEWER_PADDING * 2, viewportSize.value.height - IMAGE_VIEWER_PADDING * 2) : scale.value
  applyView(nextScale, next, fit.value, captureAnchor())
}
function toggleSize(): void {
  if (status.value !== 'ready') return
  if (fit.value) originalSize()
  else fitToViewport()
}
function navigate(direction: -1 | 1): void {
  const index = nextImageIndex(currentIndex.value, direction, props.items.length)
  if (index === currentIndex.value) return
  currentIndex.value = index
  emit('select', index)
}
function keydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); close() }
  const controlFocused = event.target instanceof Element && !!event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')
  const direction = viewerNavigationDirection(event.key, props.items.length, event.ctrlKey || event.metaKey || event.altKey || event.shiftKey, controlFocused)
  if (direction !== null) { event.preventDefault(); navigate(direction) }
}
watch([() => props.index, () => props.items.length], () => {
  currentIndex.value = Math.max(0, Math.min(props.items.length - 1, Number.isInteger(props.index) ? props.index : 0))
}, { immediate: true })
// Background gallery resolutions must not reset the current image's zoom or scroll.
watch([currentIndex, () => current.value?.url, () => current.value?.loading], resetImage, { immediate: true })
onMounted(() => {
  mounted = true
  origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
  dialog.value?.addEventListener('wheel', wheel, { passive: false })
  measureViewport()
  observer = new ResizeObserver(() => { measureViewport(); if (fit.value && status.value === 'ready') fitToViewport() })
  if (viewport.value) observer.observe(viewport.value)
})
onBeforeUnmount(() => {
  generation.value++
  cancelViewUpdate()
  clearTimeout(announcementTimer)
  dialog.value?.removeEventListener('wheel', wheel)
  observer?.disconnect()
  dialog.value?.close()
  if (mounted) document.body.style.overflow = previousOverflow
  if (origin?.isConnected) origin.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="image-viewer"
      :aria-label="copy.title"
      @cancel.prevent="close"
      @click.self="close"
      @keydown="keydown"
    >
      <button
        class="image-viewer-close"
        type="button"
        :aria-label="copy.close"
        :title="copy.close"
        autofocus
        @click="close"
      >
        ×
      </button>
      <div
        ref="viewport"
        class="image-viewer-viewport"
        tabindex="0"
        :aria-label="current?.label || copy.image"
        aria-describedby="image-viewer-hint"
        @click.self="close"
      >
        <div
          class="image-viewer-canvas"
          @click.self="close"
        >
          <div
            v-if="source && status !== 'error'"
            ref="frame"
            class="image-viewer-frame"
            :class="{ 'image-viewer-image-loading': status === 'loading' }"
            :style="{ width: `${orientedSize.width * scale}px`, height: `${orientedSize.height * scale}px` }"
          >
            <img
              :key="generation"
              ref="image"
              class="image-viewer-image"
              :src="source"
              :alt="current?.label || copy.image"
              :data-generation="generation"
              :style="{ width: `${width * scale}px`, height: `${height * scale}px`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }"
              draggable="false"
              @dblclick.prevent="toggleSize"
              @dragstart.prevent
              @load="load"
              @error="fail"
            >
          </div>
          <p
            v-if="!current"
            class="image-viewer-message"
            role="status"
          >
            {{ copy.empty }}
          </p>
          <p
            v-else-if="status === 'error'"
            class="image-viewer-message"
            role="alert"
          >
            {{ copy.unavailable }}
          </p>
          <p
            v-else-if="status === 'loading'"
            class="image-viewer-message"
            role="status"
          >
            {{ copy.loading }}
          </p>
        </div>
      </div>
      <div
        class="image-viewer-toolbar"
        role="toolbar"
        :aria-label="copy.title"
      >
        <template v-if="items.length > 1">
          <button
            type="button"
            :aria-label="copy.previous"
            :title="copy.previous"
            @click="navigate(-1)"
          >
            ‹
          </button>
          <span
            class="image-viewer-index"
            aria-live="polite"
          >{{ currentIndex + 1 }} / {{ items.length }}</span>
          <button
            type="button"
            :aria-label="copy.next"
            :title="copy.next"
            @click="navigate(1)"
          >
            ›
          </button>
          <span
            class="image-viewer-separator"
            aria-hidden="true"
          />
        </template>
        <button
          type="button"
          :aria-label="copy.zoomOut"
          :title="copy.zoomOut"
          :disabled="status !== 'ready' || scale <= minimumScale"
          @click="zoom(-1)"
        >
          −
        </button>
        <span
          class="image-viewer-scale"
        >{{ Math.round(scale * 100) }}%</span>
        <button
          type="button"
          :aria-label="copy.zoomIn"
          :title="copy.zoomIn"
          :disabled="status !== 'ready' || scale >= MAX_IMAGE_SCALE"
          @click="zoom(1)"
        >
          +
        </button>
        <span
          class="image-viewer-separator"
          aria-hidden="true"
        />
        <button
          type="button"
          class="image-viewer-text-button"
          :aria-label="copy.fit"
          :aria-pressed="fit"
          :disabled="status !== 'ready'"
          @click="fitToViewport"
        >
          {{ copy.fit }}
        </button>
        <button
          type="button"
          class="image-viewer-text-button"
          :aria-label="copy.original"
          :aria-pressed="!fit && scale === 1"
          :disabled="status !== 'ready'"
          @click="originalSize"
        >
          100%
        </button>
        <button
          type="button"
          :aria-label="copy.rotate"
          :title="copy.rotate"
          :disabled="status !== 'ready'"
          @click="rotate"
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" />
          </svg>
        </button>
      </div>
      <p
        id="image-viewer-hint"
        class="image-viewer-hint"
      >
        {{ hint }}
      </p>
      <span
        class="image-viewer-announcement"
        role="status"
      >{{ announcement }}</span>
    </dialog>
  </Teleport>
</template>
