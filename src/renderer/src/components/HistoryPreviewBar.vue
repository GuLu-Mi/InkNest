<script setup lang="ts">
import { copy } from '../../../shared/copy'
defineProps<{ savedAt: string | null; loading: boolean; disabled: boolean; reason: string; notice: string; outlineOpen: boolean; historyOpen: boolean }>()
const emit = defineEmits<{ exit: []; export: []; outline: []; history: [] }>()
</script>
<template>
  <div class="history-preview-bar">
    <div class="history-preview-actions">
      <button
        class="outline-trigger"
        :aria-expanded="outlineOpen"
        aria-label="文档目录"
        @click="emit('outline')"
      >
        目录
      </button>
      <span role="status">{{ savedAt ? copy.historyPreviewing(new Date(savedAt).toLocaleTimeString()) : loading ? copy.historyLoading : copy.history }}</span><button @click="emit('exit')">
        {{ copy.historyReturn }}
      </button><button
        :disabled="disabled || !savedAt"
        @click="emit('export')"
      >
        {{ copy.saveAs }}
      </button>
      <button
        :aria-expanded="historyOpen"
        @click="emit('history')"
      >
        {{ copy.history }}
      </button>
    </div>
    <p
      v-if="reason || notice"
      role="status"
    >
      {{ notice || reason }}
    </p>
  </div>
</template>
