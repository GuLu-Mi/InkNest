<script setup lang="ts">
import { editorSearchExtension, editorSearchSurface } from '../search/editor-search'
import type { SearchSurface } from '../search/search-model'
import { copy } from '../../../shared/copy'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import type { SessionRef } from '../../../shared/contracts'
import type { DocumentSession } from '../documents/session'
const props = defineProps<{ session: DocumentSession; editorTop: number }>()
const emit = defineEmits<{ searchSurface: [value: SearchSurface | null]; scroll: [ref: SessionRef, top: number]; composition: [ref: SessionRef, value: boolean]; line: [ref: SessionRef, zeroBasedLine: number] }>()
const host = ref<HTMLDivElement>()
let view: EditorView | undefined
let unsubscribeRestore: (() => void) | undefined
let composing = false
const waiters = new Set<(settled: boolean) => void>()
const availability = props.session.viewAvailability
let compositionTimer: ReturnType<typeof setTimeout> | undefined
function compositionStart(): void { clearTimeout(compositionTimer); composing = true; emit('composition', props.session.document, true) }
function compositionEnd(): void {
  compositionTimer = setTimeout(() => { composing = false; emit('composition', props.session.document, false); for (const resolve of waiters) resolve(true); waiters.clear() }, 0)
}
function scroll(): void { if (view) emit('scroll', props.session.document, view.scrollDOM.scrollTop) }
onMounted(() => {
  props.session.configureView(() => [
    availability.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    editorSearchExtension, lineNumbers(), markdown(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
    EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="inknest-style-nonce"]')?.content ?? ''),
    EditorView.contentAttributes.of({ 'aria-label': copy.source, role: 'textbox', 'aria-multiline': 'true' })
  ])
  view = new EditorView({ parent: host.value!, state: props.session.state, ...(props.session.editorScroll ? { scrollTo: props.session.editorScroll } : {}), dispatchTransactions: (transactions, editor) => {
    editor.update(props.session.apply(transactions))
    emit('line', props.session.document, editor.state.doc.lineAt(editor.state.selection.main.head).number - 1)
  } })
  unsubscribeRestore = props.session.subscribeHistoryRestore(transaction => view?.update([transaction]))
  view.contentDOM.addEventListener('compositionstart', compositionStart)
  view.contentDOM.addEventListener('compositionend', compositionEnd)
  view.focus()
  if (!props.session.editorScroll) view.scrollDOM.scrollTop = props.editorTop
  view.scrollDOM.addEventListener('scroll', scroll)
  setFrozen(props.session.frozen)
  emit('searchSurface', editorSearchSurface(view, () => !props.session.frozen && !props.session.document.readOnlyReason, () => props.session.error))
})
async function settleComposition(): Promise<boolean> {
  if (!composing && !view?.composing) return true
  return new Promise(resolve => {
    const done = (settled: boolean) => { clearTimeout(timer); waiters.delete(done); resolve(settled) }
    const timer = setTimeout(() => done(false), 5000)
    waiters.add(done)
    view?.contentDOM.blur()
  })
}
function setFrozen(frozen: boolean): void {
  props.session.setFrozen(frozen)
  view?.dispatch({ effects: availability.reconfigure([EditorState.readOnly.of(frozen), EditorView.editable.of(!frozen)]) })
}
function revealSourceLine(zeroBasedLine: number): void {
  if (!view || composing || view.composing) return
  const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, zeroBasedLine + 1)))
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  view.focus()
}
function recordView(): void { if (view) props.session.setEditorScroll(view.scrollSnapshot()); scroll() }
defineExpose({ settleComposition, setFrozen, revealSourceLine, recordView, focus: () => view?.focus() })
onBeforeUnmount(() => {
  emit('searchSurface', null)
  unsubscribeRestore?.()
  clearTimeout(compositionTimer); emit('composition', props.session.document, false)
  if (view) props.session.setEditorScroll(view.scrollSnapshot())
  scroll()
  view?.contentDOM.removeEventListener('compositionstart', compositionStart)
  view?.contentDOM.removeEventListener('compositionend', compositionEnd)
  view?.scrollDOM.removeEventListener('scroll', scroll)
  view?.destroy()
  for (const resolve of waiters) resolve(false)
  waiters.clear()
})
</script>
<template>
  <section
    class="editor-pane"
    :aria-label="copy.editor"
  >
    <div
      ref="host"
      class="editor-host"
    />
  </section>
</template>
