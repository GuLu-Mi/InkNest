<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { HistoryEntry, SessionRef } from '../../../shared/contracts'
import { copy } from '../../../shared/copy'
const props = defineProps<{ owner: SessionRef; entries: HistoryEntry[]; selected: string | null; loading: boolean; error: string; disabled: boolean; restoreBlocked: boolean; compact: boolean; top: number; status: string }>()
const emit = defineEmits<{ preview: [id: string]; restore: [id: string]; close: []; current: []; retry: []; scroll: [owner: SessionRef, top: number] }>()
const host = ref<HTMLElement>(); const list = ref<HTMLElement>()
const groups = computed(() => {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  return [copy.historyToday, copy.historyYesterday, copy.historyEarlier].map((label, index) => ({ label, entries: props.entries.filter(entry => {
    const time = Date.parse(entry.savedAt); return (time >= today.getTime() ? 0 : time >= yesterday.getTime() ? 1 : 2) === index
  }) })).filter(group => group.entries.length)
})
let restored = false
async function restoreList(): Promise<void> {
  restored = false
  if (props.loading) return
  await nextTick()
  if (!props.loading && list.value) { list.value.scrollTop = props.top; restored = true }
}
watch(() => props.loading, restoreList)
onMounted(() => { if (props.compact) host.value?.querySelector<HTMLButtonElement>('button')?.focus(); void restoreList() })
</script>
<template>
  <aside
    ref="host"
    class="history-sidebar"
    :class="{ 'history-compact': compact }"
    :aria-label="copy.history"
    @keydown.esc.prevent="emit('close')"
  >
    <div class="sidebar-heading">
      <strong>{{ copy.history }}</strong><button
        :aria-label="copy.historyClose"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <button
      class="history-current"
      :aria-current="!selected ? 'true' : undefined"
      @click="emit('current')"
    >
      {{ copy.historyCurrent }}<small>{{ status }}</small>
    </button>
    <div
      ref="list"
      class="history-list"
      @scroll="restored && emit('scroll', owner, ($event.target as HTMLElement).scrollTop)"
    >
      <p
        v-if="loading"
        role="status"
      >
        {{ copy.historyLoading }}
      </p>
      <div
        v-else-if="error"
        role="alert"
      >
        <p>{{ error }}</p><button
          :disabled="disabled"
          @click="emit('retry')"
        >
          {{ copy.retry }}
        </button>
      </div>
      <p v-else-if="!entries.length">
        {{ 'displayPath' in owner && !owner.displayPath ? copy.untitledHistory : copy.noHistory }}
      </p>
      <section
        v-for="group in groups"
        v-else
        :key="group.label"
        :aria-label="group.label"
      >
        <h3>{{ group.label }}</h3>
        <ul>
          <li
            v-for="entry in group.entries"
            :key="entry.id"
            :class="{ selected: entry.id === selected }"
            @click="!disabled && emit('preview', entry.id)"
          >
            <button
              class="history-time"
              :disabled="disabled"
              @click.stop="emit('preview', entry.id)"
            >
              {{ new Date(entry.savedAt).toLocaleString() }}
            </button>
            <small>{{ copy.historySources[entry.source] }} · {{ entry.byteLength }} {{ copy.bytes }}</small>
            <small v-if="entry.source === 'auto' && !entry.sealed"> · {{ copy.historyMergeable }}</small>
            <div class="history-actions">
              <button
                :disabled="disabled"
                @click.stop="emit('preview', entry.id)"
              >
                {{ copy.preview }}
              </button><button
                :disabled="disabled || restoreBlocked"
                :title="restoreBlocked ? copy.historyRestoreBlocked : undefined"
                @click.stop="emit('restore', entry.id)"
              >
                {{ copy.historyRestoreEntry }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>
