<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HeadingEntry } from '../preview/document-model'
import type { OutlineState } from '../documents/outline-state'
const props = defineProps<{ sourceKey: string; state: OutlineState; active: string; compact: boolean; modal?: boolean; reason: string }>()
const emit = defineEmits<{ navigate: [heading: HeadingEntry]; toggle: [id: string]; close: []; scroll: [key: string, top: number] }>()
const host = ref<HTMLElement>(); const list = ref<HTMLElement>(); let restored = false
const visible = computed(() => props.state.visible)
const activeId = computed(() => props.state.visibleActive(props.active))
const children = computed(() => new Set(props.state.headings.map(h => h.parentId)))
const depths = computed(() => { const result = new Map<string, number>(); for (const h of props.state.headings) result.set(h.id, h.parentId ? (result.get(h.parentId) ?? 0) + 1 : 0); return result })
async function restore(): Promise<void> { restored = false; await nextTick(); if (list.value) { list.value.scrollTop = props.state.top; restored = true } }
watch(() => props.state.headings, restore)
onMounted(() => { if (props.modal && host.value instanceof HTMLDialogElement) host.value.showModal(); if (props.compact) host.value?.querySelector<HTMLButtonElement>('button')?.focus(); void restore() })
onBeforeUnmount(() => { if (host.value instanceof HTMLDialogElement) host.value.close() })
</script>
<template>
  <component
    :is="modal ? 'dialog' : 'aside'"
    ref="host"
    class="document-outline"
    :class="{ 'outline-compact': compact, 'outline-modal': modal }"
    aria-label="文档目录面板"
    @cancel.prevent="emit('close')"
    @keydown.esc.prevent="emit('close')"
  >
    <div class="sidebar-heading">
      <strong>目录</strong><button
        aria-label="关闭目录"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <nav
      ref="list"
      aria-label="文档目录"
      class="outline-list"
      @scroll="restored && emit('scroll', sourceKey, ($event.target as HTMLElement).scrollTop)"
    >
      <p v-if="!state.headings.length">
        {{ reason }}
      </p>
      <ul v-else>
        <li
          v-for="heading in visible"
          :key="heading.id"
          :style="{ paddingLeft: `${(depths.get(heading.id) ?? 0) * 12}px` }"
        >
          <button
            v-if="children.has(heading.id)"
            class="outline-fold"
            :aria-expanded="!state.collapsed.has(heading.id)"
            :aria-label="`${state.collapsed.has(heading.id) ? '展开' : '收起'} ${heading.title}`"
            @click="emit('toggle', heading.id)"
          >
            {{ state.collapsed.has(heading.id) ? '›' : '⌄' }}
          </button>
          <span
            v-else
            class="outline-fold-space"
          />
          <button
            class="outline-title"
            :aria-current="activeId === heading.id ? 'location' : undefined"
            @click="emit('navigate', heading)"
          >
            {{ heading.title || '无标题' }}
          </button>
        </li>
      </ul>
    </nav>
  </component>
</template>
