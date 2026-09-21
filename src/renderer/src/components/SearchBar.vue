<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount, useId } from 'vue'
const props = defineProps<{ query: string; caseSensitive: boolean; status: string; notice: string; label: string; canNavigate: boolean; focusRequest: number; replaceEnabled?: boolean; replacement?: string; canReplace?: boolean; replacing?: boolean; replaceNotice?: string }>()
const emit = defineEmits<{ query: [value: string]; toggleCase: []; navigate: [direction: number]; close: []; composing: [value: boolean]; replacement: [value: string]; replace: [all: boolean] }>()
const input = ref<HTMLInputElement>(), panel = ref<HTMLElement>(), draft = ref(props.query), replacementDraft = ref(props.replacement ?? '')
const selectedTab = ref<'find' | 'replace'>('find'), replacingTab = computed(() => props.replaceEnabled && selectedTab.value === 'replace'), id = useId()
let composing = false, replacementComposing = false, observer: ResizeObserver | undefined
watch(() => props.query, value => { if (!composing) draft.value = value })
watch(() => props.replacement, value => { if (!replacementComposing) replacementDraft.value = value ?? '' })
watch(() => props.replaceEnabled, enabled => { if (!enabled) selectedTab.value = 'find' })
watch(() => props.focusRequest, async () => { await nextTick(); input.value?.focus({ preventScroll: true }); input.value?.select() })
function changed(): void { if (!composing) emit('query', draft.value) }
function compositionStart(): void { composing = true; emit('composing', true) }
function compositionEnd(): void { composing = false; emit('query', draft.value); emit('composing', false) }
function replacementChanged(): void { if (!replacementComposing) emit('replacement', replacementDraft.value) }
function replacementStart(): void { replacementComposing = true; emit('composing', true) }
function replacementEnd(): void { replacementComposing = false; emit('replacement', replacementDraft.value); emit('composing', false) }
function selectTab(tab: 'find' | 'replace'): void { if (!composing && !replacementComposing) selectedTab.value = tab }
function key(event: KeyboardEvent): void {
  if (event.isComposing || composing || replacementComposing || !(event.target instanceof HTMLInputElement)) return
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (event.target.matches('.replacement-input')) emit('replace', false); else emit('navigate', event.shiftKey ? -1 : 1) }
}
async function tabKey(event: KeyboardEvent): Promise<void> {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || composing || replacementComposing) return
  event.preventDefault()
  selectedTab.value = !props.replaceEnabled || event.key === 'Home' ? 'find' : event.key === 'End' ? 'replace' : selectedTab.value === 'find' ? 'replace' : 'find'
  await nextTick(); panel.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
}
/** The overlay adapts to the existing toolbar; it never participates in toolbar layout. */
function position(): void {
  const element = panel.value, parent = element?.parentElement
  if (!element || !parent) return
  if (parent.classList.contains('document-toolbar-row')) {
    const toolbar = parent.querySelector<HTMLElement>('.document-toolbar,.history-preview-bar')
    if (toolbar) {
      const bounds = element.getBoundingClientRect(), bar = toolbar.getBoundingClientRect()
      const overlaps = bounds.left < bar.right + 12 && bounds.right > bar.left - 12
      element.style.top = `${overlaps ? toolbar.offsetTop + toolbar.offsetHeight + 8 : 0}px`
    }
  }
  element.style.maxHeight = `${Math.max(80, window.innerHeight - element.getBoundingClientRect().top - 12)}px`
}
onMounted(() => {
  observer = new ResizeObserver(position)
  if (panel.value) { observer.observe(panel.value); if (panel.value.parentElement) { observer.observe(panel.value.parentElement); const toolbar = panel.value.parentElement.querySelector('.document-toolbar,.history-preview-bar'); if (toolbar) observer.observe(toolbar) } }
  window.addEventListener('resize', position); position()
})
onBeforeUnmount(() => { observer?.disconnect(); window.removeEventListener('resize', position) })
</script>
<template>
  <section
    ref="panel"
    class="search-bar"
    role="search"
    aria-label="文档内查找"
    @keydown="key"
  >
    <div class="search-header">
      <div
        class="search-tabs"
        role="tablist"
        aria-label="查找与替换"
        @keydown="tabKey"
      >
        <button
          :id="id + '-find'"
          role="tab"
          :aria-selected="!replacingTab"
          :aria-controls="id + '-body'"
          :tabindex="replacingTab ? -1 : 0"
          @click="selectTab('find')"
        >
          查找
        </button>
        <button
          v-if="replaceEnabled"
          :id="id + '-replace'"
          role="tab"
          :aria-selected="!!replacingTab"
          :aria-controls="id + '-body'"
          :tabindex="replacingTab ? 0 : -1"
          @click="selectTab('replace')"
        >
          替换
        </button>
      </div>
      <button
        class="search-case"
        type="button"
        aria-label="区分大小写"
        title="区分大小写"
        :aria-pressed="caseSensitive"
        @click="emit('toggleCase')"
      >
        Aa
      </button>
      <button
        class="search-close"
        type="button"
        aria-label="关闭搜索"
        title="关闭（Esc）"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <div
      :id="id + '-body'"
      class="search-body"
      role="tabpanel"
      :aria-labelledby="id + (replacingTab ? '-replace' : '-find')"
    >
      <label
        v-if="replacingTab"
        class="search-label"
        :for="id + '-query'"
      >查找</label>
      <div class="search-field">
        <input
          :id="id + '-query'"
          ref="input"
          v-model="draft"
          type="text"
          :aria-label="label"
          :placeholder="label"
          autocomplete="off"
          spellcheck="false"
          @input="changed"
          @compositionstart="compositionStart"
          @compositionend="compositionEnd"
        >
        <span
          class="search-count"
          role="status"
          aria-live="polite"
          :title="status"
        >{{ status }}</span>
      </div>
      <div
        v-if="replacingTab"
        class="replacement-controls"
      >
        <label
          class="search-label"
          :for="id + '-replacement'"
        >替换为</label>
        <input
          :id="id + '-replacement'"
          v-model="replacementDraft"
          class="replacement-input"
          type="text"
          aria-label="替换为"
          placeholder="请输入文字（留空则删除）"
          autocomplete="off"
          spellcheck="false"
          :disabled="replacing"
          @input="replacementChanged"
          @compositionstart="replacementStart"
          @compositionend="replacementEnd"
        >
      </div>
      <div
        class="search-actions"
        :class="{ 'has-replacement': replacingTab }"
      >
        <template v-if="replacingTab">
          <button
            class="replace-all"
            type="button"
            :disabled="!canReplace"
            @click="emit('replace', true)"
          >
            全部替换
          </button>
          <button
            type="button"
            :disabled="!canReplace"
            @click="emit('replace', false)"
          >
            替换
          </button>
        </template>
        <button
          type="button"
          aria-label="上一处"
          title="上一处（Shift+Enter）"
          :disabled="!canNavigate"
          @click="emit('navigate', -1)"
        >
          上一处
        </button>
        <button
          type="button"
          aria-label="下一处"
          title="下一处（Enter）"
          :disabled="!canNavigate"
          @click="emit('navigate', 1)"
        >
          下一处
        </button>
      </div>
      <span
        v-if="replacingTab && (replacing || replaceNotice)"
        class="replacement-notice"
        role="status"
      >{{ replacing ? '正在替换…' : replaceNotice }}</span>
      <span
        v-if="notice"
        class="search-wrap"
        role="status"
      >{{ notice }}</span>
    </div>
  </section>
</template>
