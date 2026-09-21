import { copy } from '../../../shared/copy'
import type { AppError, HistorySnapshot, InkNestAPI, Result, SessionRef, TabViewState } from '../../../shared/contracts'

/** The host supplies its live active owner and increments generation on every path migration. */
export interface HistoryPreviewContext { ref: SessionRef; pathGeneration: number; view: TabViewState }
export interface HistoryPreviewState {
  ref: SessionRef
  pathGeneration: number
  historyId: string
  snapshot: HistorySnapshot | null
  error: AppError | null
  loading: boolean
  available: boolean
}
interface Options {
  api: Pick<InkNestAPI, 'inspectHistory'>
  current: () => HistoryPreviewContext | null
  changed?: () => void
}
const sameRef = (a: SessionRef, b: SessionRef) => a.docId === b.docId && a.epoch === b.epoch
const copyView = (view: TabViewState): TabViewState => ({ ...view, reading: { ...view.reading } })

/** Display-only state: no session mutation, mode switch, save or recovery capability. */
export class HistoryPreviewController {
  private preview: HistoryPreviewState | null = null
  private returnView: TabViewState | null = null
  private sequence = 0
  constructor(private readonly options: Options) {}

  private owns(state: HistoryPreviewState): boolean {
    const current = this.options.current()
    return !!current && sameRef(current.ref, state.ref) && current.pathGeneration === state.pathGeneration
  }
  get state(): HistoryPreviewState | null {
    if (this.preview && !this.owns(this.preview)) this.invalidate()
    return this.preview
  }
  get selectedId(): string | null { return this.state?.historyId ?? null }

  async enter(ref: SessionRef, historyId: string): Promise<void> {
    // Check the prior owner before a new selection, retaining its bookmark only for the same owner.
    const previous = this.state
    const current = this.options.current()
    if (!current || !sameRef(current.ref, ref)) return
    if (!previous) this.returnView = copyView(current.view)
    const state: HistoryPreviewState = { ref: { docId: ref.docId, epoch: ref.epoch }, pathGeneration: current.pathGeneration, historyId, snapshot: null, error: null, loading: true, available: true }
    const sequence = ++this.sequence
    this.preview = state
    this.options.changed?.()
    let result: Result<HistorySnapshot>
    try { result = await this.options.api.inspectHistory(state.ref, historyId) }
    catch { result = { status: 'error', error: { code: 'IO_ERROR', message: copy.backupActionFailed, retryable: true } } }
    if (sequence !== this.sequence || this.preview !== state) return
    if (!this.owns(state)) { this.invalidate(); return }
    state.loading = false
    if (result.status === 'ok') {
      if (result.value.id === historyId) state.snapshot = result.value
      else state.error = { code: 'INVALID_REQUEST', message: copy.historyMismatch, retryable: false }
    } else if (result.status === 'error') state.error = result.error
    this.options.changed?.()
  }

  reconcileListing(ids: Set<string>): void {
    const state = this.state
    if (!state) return
    state.available = ids.has(state.historyId)
    this.options.changed?.()
  }
  /** The host reapplies this view bookmark without invoking its save-triggering setMode action. */
  exit(): TabViewState | null {
    const view = this.state && this.returnView ? copyView(this.returnView) : null
    this.invalidate()
    return view
  }
  /** Call synchronously on tab switch/close, epoch replacement, migration and history cleanup. */
  invalidate(): void {
    this.sequence++
    this.preview = null
    this.returnView = null
    this.options.changed?.()
  }
}
