<script setup lang="ts">
import SearchBar from '../components/SearchBar.vue'
import { useDocumentSearch } from '../search/use-document-search'
import type { SearchSurface } from '../search/search-model'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { copy } from '../../../shared/copy'
import type { HeadingEntry } from '../preview/document-model'
import PreviewPane from '../preview/PreviewPane.vue'
import DocumentOutline from '../components/DocumentOutline.vue'
import PresentationControls from './PresentationControls.vue'
import type { usePresentation } from './use-presentation'
const props = defineProps<{ presentation: ReturnType<typeof usePresentation>; notice: boolean }>()
const stage = ref<HTMLElement>(); const preview = ref<InstanceType<typeof PreviewPane>>()
const { snapshot, parsed, sourceKey, outlineOpen, outline, activeHeading, bookmark } = props.presentation
const searchSurface = shallowRef<SearchSurface | null>(null)
const searchSource = computed(() => snapshot.value ? { key: sourceKey.value, stateKey: sourceKey.value, version: snapshot.value.revision, label: '搜索演示快照' } : null)
const search = useDocumentSearch(searchSource, searchSurface, outlineOpen, computed(() => [sourceKey.value]), async () => true)
defineExpose({ searchCommand: search.command })
async function closeOutline(): Promise<void> { outlineOpen.value = false; await nextTick(); document.querySelector<HTMLButtonElement>('.presentation-controls button')?.focus() }
async function navigate(heading: HeadingEntry): Promise<void> { outlineOpen.value = false; await nextTick(); preview.value?.revealHeading(heading.id) }
function keydown(event: KeyboardEvent): void {
  // DocumentOutline consumes its own Escape before it bubbles to this window listener.
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.preventDefault(); if (outlineOpen.value) void closeOutline(); else void props.presentation.exit(); return }
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || outlineOpen.value || (event.target instanceof Element && event.target.closest('button,input,textarea,select,[contenteditable="true"],[role="button"]'))) return
  const target = stage.value; if (!target) return
  const distance = Math.max(40, target.clientHeight * .9)
  const deltas: Record<string, number> = { ArrowDown: 48, ArrowUp: -48, PageDown: distance, PageUp: -distance, ' ': event.shiftKey ? -distance : distance }
  if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); target.scrollTop = event.key === 'Home' ? 0 : target.scrollHeight }
  else if (event.key in deltas) { event.preventDefault(); target.scrollTop += deltas[event.key]! }
}
onMounted(() => { window.addEventListener('keydown', keydown); stage.value?.focus() })
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>
<template>
  <section
    class="presentation"
    role="region"
    aria-label="全屏连续阅读"
  >
    <PresentationControls
      :outline-open="outlineOpen"
      @outline="outlineOpen = !outlineOpen"
      @exit="presentation.exit"
    />
    <p
      v-if="notice"
      class="presentation-notice"
      role="status"
    >
      {{ copy.presentationChanged }}
    </p>
    <DocumentOutline
      v-if="outlineOpen"
      :source-key="sourceKey"
      :state="outline"
      :active="activeHeading"
      :compact="true"
      :modal="true"
      :reason="snapshot?.readOnlyReason === 'size' ? '大文件使用纯文本阅读，目录暂不可用' : '此文档没有标题'"
      @navigate="navigate"
      @toggle="outline.toggle"
      @close="closeOutline"
      @scroll="(_key, top) => outline.top = top"
    />
    <SearchBar
      v-if="search.visible.value"
      :key="searchSource?.key ?? ''"
      :query="search.state.value.query"
      :case-sensitive="search.state.value.caseSensitive"
      :status="search.status.value"
      :notice="search.wrap.value"
      :label="searchSource?.label ?? '搜索文档正文'"
      :can-navigate="search.canNavigate.value"
      :focus-request="search.focusRequest.value"
      @query="search.setQuery"
      @toggle-case="search.toggleCase"
      @navigate="search.move"
      @close="search.close"
      @composing="search.composing.value = $event"
    />
    <main
      ref="stage"
      class="document-stage presentation-stage"
      tabindex="-1"
      aria-label="演示正文"
    >
      <PreviewPane
        v-if="snapshot"
        :key="sourceKey"
        ref="preview"
        :document="snapshot"
        :parsed="parsed"
        :source-key="sourceKey"
        :bookmark="bookmark"
        @search-surface="searchSurface = $event"
        @bookmark="(_ref, value) => bookmark = value"
        @active="(_key, id) => activeHeading = id"
      />
    </main>
  </section>
</template>
