<script setup lang="ts">
import { copy } from '../../../shared/copy'
import type { Mode } from '../../../shared/contracts'
defineProps<{ mode: Mode; editable: boolean; disabled: boolean; historyOpen: boolean; outlineOpen: boolean; presentationDisabled: boolean }>()
const emit = defineEmits<{ mode: [value: Mode]; history: []; outline: []; presentation: [] }>()
</script>
<template>
  <div class="document-toolbar">
    <button
      class="outline-trigger"
      :aria-expanded="outlineOpen"
      aria-label="文档目录"
      @click="emit('outline')"
    >
      目录
    </button>
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
      ▷
    </button>
    <button
      type="button"
      :aria-expanded="historyOpen"
      @click="emit('history')"
    >
      {{ copy.history }}
    </button>
  </div>
</template>
