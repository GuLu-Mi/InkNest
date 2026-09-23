<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copy } from '../../../shared/copy'
import type { Mode, OpenDocument, SessionRef } from '../../../shared/contracts'
import DocumentIcon from './DocumentIcon.vue'
const props = defineProps<{
  document: OpenDocument; mode: Mode; editable: boolean; disabled: boolean
  saveDisabled: boolean; saveAsDisabled: boolean; closeDisabled: boolean; saving: boolean
  historyOpen: boolean; outlineOpen: boolean; presentationDisabled: boolean
}>()
const emit = defineEmits<{ mode: [value: Mode]; history: []; outline: []; presentation: []; save: []; saveAs: []; close: [ref: SessionRef] }>()
const group = ref<HTMLElement>(), more = ref<HTMLButtonElement>(), menu = ref<HTMLElement>()
const menuOpen = ref(false)
const showSave = computed(() => props.editable && props.mode === 'edit')
const isMac = /Mac/.test(navigator.platform)
const saveShortcut = isMac ? '⌘S' : 'Ctrl+S'
const saveAsShortcut = isMac ? '⌘⇧S' : 'Ctrl+Shift+S'
function closeMenu(focus = false): void { menuOpen.value = false; if (focus) more.value?.focus() }
async function toggleMenu(keyboard = false): Promise<void> {
  menuOpen.value = keyboard || !menuOpen.value
  if (menuOpen.value && keyboard) { await nextTick(); menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
}
function menuKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (!buttons.length) return
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  event.preventDefault(); buttons[next]?.focus()
}
function act(action: 'saveAs' | 'close'): void {
  const owner = { docId: props.document.docId, epoch: props.document.epoch }
  closeMenu(true)
  if (action === 'saveAs') emit('saveAs'); else emit('close', owner)
}
function outside(event: PointerEvent): void { if (!group.value?.contains(event.target as Node)) closeMenu() }
function leave(event: FocusEvent): void { if (!group.value?.contains(event.relatedTarget as Node | null)) closeMenu() }
watch([() => props.document.docId, () => props.document.epoch, () => props.disabled, () => props.saving, () => props.closeDisabled, showSave], () => closeMenu())
onMounted(() => window.document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => window.document.removeEventListener('pointerdown', outside))
</script>
<template>
  <div
    class="document-toolbar"
    :class="{ 'is-reading': !showSave }"
    role="group"
    :aria-label="copy.documentActions(document.displayName)"
  >
    <button
      class="outline-trigger"
      type="button"
      :aria-expanded="outlineOpen"
      aria-label="文档目录"
      @click="emit('outline')"
    >
      <DocumentIcon name="outline" />目录
    </button>
    <div
      class="document-identity"
      :title="document.displayPath ?? document.displayName"
    >
      <DocumentIcon name="file" /><span class="document-name">{{ document.displayName }}</span>
    </div>
    <div
      v-if="showSave"
      ref="group"
      class="document-save-group"
      @focusout="leave"
    >
      <button
        type="button"
        class="document-save"
        :aria-label="copy.saveCurrent(document.displayName)"
        :title="`${copy.saveCurrent(document.displayName)}（${saveShortcut}）`"
        :disabled="saveDisabled"
        @click="closeMenu(); emit('save')"
      >
        <DocumentIcon :name="saving ? 'saving' : 'save'" />
        <span>{{ saving ? copy.saving : document.displayPath ? copy.save : copy.initialSave }}</span>
      </button>
      <button
        ref="more"
        type="button"
        class="document-save-more"
        :aria-label="copy.moreDocumentActions"
        :title="copy.moreDocumentActions"
        :aria-expanded="menuOpen"
        aria-controls="document-save-menu"
        :disabled="saving || (saveAsDisabled && closeDisabled)"
        @click="toggleMenu()"
        @keydown.down.prevent="toggleMenu(true)"
        @keydown.esc.stop.prevent="closeMenu()"
      >
        <DocumentIcon name="chevron" />
      </button>
      <div
        v-if="menuOpen"
        id="document-save-menu"
        ref="menu"
        class="document-save-menu"
        role="group"
        :aria-label="copy.documentActions(document.displayName)"
        @keydown="menuKey"
      >
        <button
          type="button"
          :disabled="saveAsDisabled"
          @click="act('saveAs')"
        >
          <span>{{ copy.saveAs }}</span><kbd aria-hidden="true">{{ saveAsShortcut }}</kbd>
        </button>
        <button
          type="button"
          :disabled="closeDisabled"
          @click="act('close')"
        >
          <span>{{ copy.closeDocument }}</span><kbd aria-hidden="true">{{ isMac ? '⌘W' : 'Ctrl+W' }}</kbd>
        </button>
      </div>
    </div>
    <div class="document-view-actions">
      <button
        v-if="editable"
        type="button"
        :disabled="disabled"
        @click="emit('mode', mode === 'read' ? 'edit' : 'read')"
      >
        {{ mode === 'read' ? copy.edit : copy.preview }}
      </button>
      <button
        class="presentation-trigger"
        type="button"
        :aria-label="copy.presentation"
        :title="copy.presentation"
        :disabled="presentationDisabled"
        @click="emit('presentation')"
      >
        <DocumentIcon name="play" />
      </button>
      <button
        class="history-trigger"
        type="button"
        :aria-label="copy.history"
        :title="copy.history"
        :aria-expanded="historyOpen"
        @click="emit('history')"
      >
        <DocumentIcon name="history" />
      </button>
    </div>
  </div>
</template>
