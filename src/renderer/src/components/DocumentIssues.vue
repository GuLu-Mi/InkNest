<script setup lang="ts">
import { copy } from '../../../shared/copy'
import type { ConflictAction, DiskStatus } from '../../../shared/contracts'
defineProps<{ status: DiskStatus; inspection: string | null; disabled: boolean; canInspect: boolean; canSaveCopy: boolean }>()
defineEmits<{ resolve: [action: ConflictAction] }>()
</script>
<template>
  <section
    class="document-issues"
    :aria-label="copy.issues"
  >
    <p>{{ status === 'missing' ? copy.missingDocument : status === 'unavailable' ? copy.unavailableDocument : copy.conflict }}</p>
    <div class="issue-actions">
      <button
        type="button"
        :disabled="disabled || !canInspect || status !== 'changed'"
        @click="$emit('resolve', 'inspect')"
      >
        {{ copy.inspectDisk }}
      </button>
      <button
        type="button"
        :disabled="disabled || !canSaveCopy"
        @click="$emit('resolve', 'save-copy')"
      >
        {{ copy.saveAs }}
      </button>
      <button
        type="button"
        :disabled="disabled || !canInspect || status !== 'changed'"
        @click="$emit('resolve', 'use-disk')"
      >
        {{ copy.useDisk }}
      </button>
      <button
        type="button"
        :disabled="disabled || !canInspect || status !== 'changed'"
        @click="$emit('resolve', 'overwrite')"
      >
        {{ copy.overwriteDisk }}
      </button>
    </div>
    <pre
      v-if="inspection !== null"
      :aria-label="copy.diskVersion"
      tabindex="0"
    >{{ inspection }}</pre>
  </section>
</template>
<style scoped>
.document-issues { padding: 12px 24px; background: var(--warning-surface); color: var(--warning-text); border-bottom: 1px solid var(--border-subtle); }
.document-issues p { margin: 0 0 8px; }
.issue-actions { display: flex; flex-wrap: wrap; gap: 8px; }
pre { max-height: 180px; overflow: auto; white-space: pre-wrap; user-select: text; background: var(--surface); color: var(--text-primary); padding: 12px; }
</style>
