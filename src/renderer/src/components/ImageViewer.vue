<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { imageViewerCopy as copy } from '../../../shared/image-viewer-copy'
import { fitImageScale, imageViewerUrl, nextImageIndex, zoomImageScale, viewerNavigationDirection, imageViewerLoadStatus, type ViewerImage } from '../preview/image-viewer'
import './image-viewer.css'

const props = defineProps<{ items: readonly ViewerImage[]; index: number }>()
const emit = defineEmits<{ close: []; select: [index: number] }>()
const dialog = ref<HTMLDialogElement>()
const viewport = ref<HTMLElement>()
const image = ref<HTMLImageElement>()
const currentIndex = ref(0)
const current = computed(() => props.items[currentIndex.value])
const source = computed(() => current.value ? imageViewerUrl(current.value.url) : null)
const scale = ref(1)
const width = ref(0)
const height = ref(0)
const fit = ref(true)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const generation = ref(0)
let observer: ResizeObserver | undefined
let origin: HTMLElement | null = null
let previousOverflow = ''
let mounted = false
let closing = false

function close(): void {
  if (closing) return
  closing = true
  emit('close')
}
function resetScroll(): void {
  if (viewport.value) { viewport.value.scrollTop = 0; viewport.value.scrollLeft = 0 }
}
function fitToViewport(): void {
  fit.value = true
  if (viewport.value) scale.value = fitImageScale(width.value, height.value, viewport.value.clientWidth - 48, viewport.value.clientHeight - 48)
  void nextTick(resetScroll)
}
function resetImage(): void {
  generation.value++
  width.value = 0; height.value = 0; scale.value = 1; fit.value = true
  status.value = imageViewerLoadStatus(current.value)
  void nextTick(resetScroll)
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
  if (event.target === image.value) status.value = 'error'
}
function zoom(direction: -1 | 1): void {
  fit.value = false
  scale.value = zoomImageScale(scale.value, direction)
}
function originalSize(): void { fit.value = false; scale.value = 1; void nextTick(resetScroll) }
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
  observer = new ResizeObserver(() => { if (fit.value && status.value === 'ready') fitToViewport() })
  if (viewport.value) observer.observe(viewport.value)
})
onBeforeUnmount(() => {
  generation.value++
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
      @wheel.stop
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
        @click.self="close"
      >
        <div
          class="image-viewer-canvas"
          @click.self="close"
        >
          <img
            v-if="source && status !== 'error'"
            :key="generation"
            ref="image"
            class="image-viewer-image"
            :class="{ 'image-viewer-image-loading': status === 'loading' }"
            :src="source"
            :alt="current?.label || copy.image"
            :data-generation="generation"
            :style="status === 'ready' ? { width: `${width * scale}px`, height: `${height * scale}px` } : undefined"
            draggable="false"
            @dblclick.prevent="toggleSize"
            @dragstart.prevent
            @load="load"
            @error="fail"
          >
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
          :disabled="status !== 'ready' || scale <= 0.1"
          @click="zoom(-1)"
        >
          −
        </button>
        <span
          class="image-viewer-scale"
          aria-live="polite"
        >{{ Math.round(scale * 100) }}%</span>
        <button
          type="button"
          :aria-label="copy.zoomIn"
          :title="copy.zoomIn"
          :disabled="status !== 'ready' || scale >= 4"
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
      </div>
    </dialog>
  </Teleport>
</template>
