<script setup lang="ts">
import ThemeSwitch from './ThemeSwitch.vue'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionRef } from '../../../shared/contracts'
import { copy } from '../../../shared/copy'
import type { TabState } from '../documents/workspace'
const props = defineProps<{ tabs: readonly TabState[]; active: SessionRef | null; disabled: boolean; busy: boolean }>()
const emit = defineEmits<{ activate: [ref: SessionRef]; close: [ref: SessionRef]; open: [] }>()
const strip = ref<HTMLElement>()
const selected = (tab: TabState) => props.active?.docId === tab.document.docId && props.active.epoch === tab.document.epoch
function revealActive(): void { strip.value?.querySelector('[aria-selected="true"]')?.closest('.document-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
watch(() => props.active, async () => { await nextTick(); revealActive() })
const resize = new ResizeObserver(revealActive)
onMounted(() => { if (strip.value) resize.observe(strip.value) })
onBeforeUnmount(() => resize.disconnect())
function navigate(event: KeyboardEvent, index: number): void {
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length
  else if (event.key === 'ArrowLeft') next = (index + props.tabs.length - 1) % props.tabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = props.tabs.length - 1
  else return
  event.preventDefault(); strip.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  emit('activate', props.tabs[next]!.document)
}
</script>
<template>
  <div class="tabs-header">
    <div
      ref="strip"
      class="document-tabs"
      role="tablist"
      :aria-label="copy.tabs"
    >
      <div
        v-for="(tab, index) in tabs"
        :key="tab.document.epoch"
        class="document-tab"
        :class="{ selected: selected(tab) }"
        role="presentation"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="selected(tab)"
          :tabindex="selected(tab) ? 0 : -1"
          :title="tab.document.displayPath ?? tab.document.displayName"
          :disabled="disabled"
          @click="emit('activate', tab.document)"
          @keydown="navigate($event, index)"
        >
          <span
            v-if="tab.session?.dirty"
            class="tab-dot"
            aria-hidden="true"
          >•</span>
          <span class="tab-name">{{ tab.document.displayName }}</span>
          <span
            v-if="tab.error || tab.saveError || tab.recoveryError || tab.diskStatus !== 'current'"
            class="tab-error"
          >{{ copy.tabError }}</span>
        </button>
        <button
          type="button"
          class="close-tab"
          :aria-label="copy.closeLabel(index)"
          :title="copy.closeTitle(tab.document.displayName)"
          :disabled="disabled || tab.frozen"
          @click="emit('close', tab.document)"
        >
          ×
        </button>
      </div>
    </div>
    <button
      type="button"
      class="open-tab"
      :aria-label="copy.openDocument"
      :title="copy.openDocument"
      :disabled="disabled || busy"
      @click="emit('open')"
    >
      +
    </button>
    <div class="titlebar-space" />
    <slot />
    <ThemeSwitch />
  </div>
</template>
