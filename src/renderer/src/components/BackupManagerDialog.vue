<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copy } from '../../../shared/copy'
import type { RecoveryEntry } from '../../../shared/contracts'
import { buildPreview } from '../preview/pipeline'
import { codeAction, enhancePreview } from '../preview/rich-content'
import { darkTheme } from '../theme'
const props = defineProps<{ open: boolean; disabled: boolean; welcome: boolean }>()
const emit = defineEmits<{ close: []; found: [count: number]; failure: [message: string]; cleaned: [] }>()
const dialog = ref<HTMLDialogElement>(); const recovery = ref<RecoveryEntry[]>([]); const preview = ref(''); const error = ref(''); const notice = ref(''); const working = ref(false)
const previewHost = ref<HTMLElement>()
let enhancement: AbortController | null = null
let previewLinks: string[] = []
watch([preview, darkTheme], async () => {
  enhancement?.abort(); const current = new AbortController(); enhancement = current
  await nextTick()
  if (!current.signal.aborted && props.open && previewHost.value) void enhancePreview(previewHost.value, darkTheme.value, current.signal, () => {}).catch(() => {})
})
function previewAction(event: MouseEvent | KeyboardEvent): void {
  if (!(event.target instanceof Element)) return
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
  if (event instanceof MouseEvent && event.button !== 0) return
  if (event.target.closest('button[data-code-action]')) { event.preventDefault(); void codeAction(event.target, message => { notice.value = message }, () => {}); return }
  const anchor = event.target.closest<HTMLElement>('a[data-link-index]')
  const target = anchor ? previewLinks[Number(anchor.dataset.linkIndex)] : ''
  if (!target?.startsWith('#inknest-footnote-')) return
  const node = [...(previewHost.value?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(node => node.id === target.slice(1))
  if (node) {
    event.preventDefault()
    for (let details = node.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true
    node.scrollIntoView({ block: 'nearest' }); node.focus({ preventScroll: true })
  }
}
let sequence = 0; let refreshSequence = 0
async function refresh(): Promise<void> {
  const current = ++refreshSequence
  try {
    const result = await window.inknest.listRecovery()
    if (current !== refreshSequence) return
    if (result.status === 'ok') { recovery.value = result.value; error.value = ''; emit('found', result.value.length); emit('failure', '') }
    else if (result.status === 'error') { error.value = result.error.message; emit('failure', error.value) }
  } catch { if (current === refreshSequence) { error.value = copy.backupActionFailed; emit('failure', error.value) } }
}
async function action(kind: 'inspect' | 'restore' | 'discard' | 'clear-recovery' | 'clear-history', id = ''): Promise<void> {
  if (working.value || props.disabled) return
  const current = ++sequence; working.value = true; error.value = ''; notice.value = ''
  try {
    const result = kind === 'inspect' ? await window.inknest.inspectRecovery(id) : kind === 'restore' ? await window.inknest.restoreRecovery(id) : kind === 'discard' ? await window.inknest.discardRecovery(id) : await window.inknest.clearRecords(kind === 'clear-recovery' ? 'recovery' : 'history')
    if (current !== sequence) return
    if (result.status === 'error') error.value = result.error.message
    else if (result.status === 'ok') {
      if (kind === 'inspect' && typeof result.value === 'string') { const resultPreview = await buildPreview(result.value, null, window.inknest); if (current === sequence) { preview.value = resultPreview.html; previewLinks = resultPreview.links ?? [] } }
      else if (kind === 'restore') emit('close')
      else { preview.value = ''; if (kind.startsWith('clear')) notice.value = copy.cleanupDone; if (kind === 'clear-history') emit('cleaned') }
    }
    const savedError = error.value; await refresh(); if (savedError) error.value = savedError
  } catch { if (current === sequence) error.value = copy.backupActionFailed }
  finally { working.value = false }
}
watch(() => props.open, async open => { await nextTick(); if (open) { dialog.value?.showModal(); void refresh() } else { sequence++; preview.value = ''; dialog.value?.close() } })
watch(() => props.welcome, welcome => { if (welcome) void refresh() })
onMounted(() => { void refresh(); if (props.open) dialog.value?.showModal() })
onBeforeUnmount(() => { enhancement?.abort(); sequence++; refreshSequence++; dialog.value?.close() })
</script>
<template>
  <dialog
    ref="dialog"
    class="backup-dialog"
    :aria-label="copy.backupsTitle"
    @cancel.prevent="emit('close')"
  >
    <div class="sidebar-heading">
      <strong>{{ copy.backupsTitle }}</strong><button
        :aria-label="copy.backupClose"
        autofocus
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <div class="backup-scroll">
      <p>{{ copy.backupDescription }}</p>
      <div class="backup-actions">
        <button
          :disabled="working || disabled"
          @click="refresh"
        >
          {{ copy.refreshBackups }}
        </button><button
          :disabled="working || disabled"
          @click="action('clear-recovery')"
        >
          {{ copy.clearDrafts }}
        </button><button
          :disabled="working || disabled"
          @click="action('clear-history')"
        >
          {{ copy.clearHistory }}
        </button>
      </div>
      <p
        v-if="error"
        role="alert"
      >
        {{ error }}
      </p><p
        v-if="notice"
        role="status"
      >
        {{ notice }}
      </p>
      <ul :aria-label="copy.recoveryList">
        <li
          v-for="entry in recovery"
          :key="entry.id"
        >
          <span>{{ entry.displayName }} · {{ entry.savedAt ? new Date(entry.savedAt).toLocaleString() : copy.timeUnavailable }}</span><p v-if="!entry.available">
            {{ copy.corruptBackup }}
          </p><div class="backup-actions">
            <button
              :disabled="working || disabled || !entry.available"
              @click="action('inspect', entry.id)"
            >
              {{ copy.inspectDraft }}
            </button><button
              :disabled="working || disabled || !entry.available"
              @click="action('restore', entry.id)"
            >
              {{ copy.restoreDraft }}
            </button><button
              :disabled="working || disabled || !entry.available"
              @click="action('discard', entry.id)"
            >
              {{ copy.discardDraft }}
            </button>
          </div>
        </li>
      </ul>
      <p v-if="!recovery.length">
        {{ copy.noRecovery }}
      </p>
      <!-- The shared restricted pipeline renders without any document resource capability. -->
      <!-- eslint-disable vue/no-v-html -->
      <article
        v-if="preview"
        ref="previewHost"
        class="markdown-body backup-preview"
        :aria-label="copy.backupBody"
        tabindex="0"
        @click="previewAction"
        @keydown="previewAction"
        v-html="preview"
      />
    </div>
  </dialog>
</template>
