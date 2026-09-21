import { copy } from '../../../shared/copy'
import { Compartment, EditorState, StateEffect, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { history, isolateHistory } from '@codemirror/commands'
import type { ContentSnapshot, HistoryRestoreReceipt, HistorySnapshot, OpenDocument, SaveReceipt } from '../../../shared/contracts'
import { EDITABLE_DOCUMENT_MAX_BYTES } from '../../../shared/limits'

/** The CodeMirror state is the only editable source; consumers receive snapshots. */
export class DocumentSession {
  private editorScrollState: ReturnType<EditorView['scrollSnapshot']> | undefined
  readonly viewAvailability = new Compartment()
  private viewConfigured = false
  private current: EditorState
  private baseline: string
  private revision: number
  private savedRevision: number
  private nextSaveOrder = 0
  private acceptedSaveOrder = 0
  private readonly submitted = new Map<string, { snapshot: ContentSnapshot; order: number }>()
  private readonly restoreTargets = new Map<string, HistorySnapshot>()
  private readonly listeners = new Set<() => void>()
  private readonly restoreListeners = new Set<(transaction: Transaction) => void>()
  private lifecycleFrozen = false
  private restoreHold: string | null = null
  private saveHold: string | null = null
  get frozen(): boolean { return this.lifecycleFrozen || this.restoreHold !== null || this.saveHold !== null }
  holdSave(requestId: string): void { if (this.submitted.has(requestId)) this.saveHold = requestId }
  set frozen(value: boolean) { this.lifecycleFrozen = value }
  error = ''
  constructor(readonly document: OpenDocument) {
    this.baseline = document.text
    this.revision = this.savedRevision = document.revision
    this.current = EditorState.create({ doc: document.text, extensions: [history(), EditorState.transactionFilter.of((transaction) => this.allows(transaction) ? transaction : [])] })
  }
  private allows(transaction: Transaction): boolean {
    if (!transaction.docChanged) return true
    if (this.frozen || this.document.readOnlyReason) return false
    const text = transaction.newDoc.toString()
    const bytes = new TextEncoder().encode(text).length + (this.document.format?.bom ? 3 : 0) + (this.document.format?.eol === 'crlf' ? transaction.newDoc.lines - 1 : 0)
    if (bytes > EDITABLE_DOCUMENT_MAX_BYTES) {
      this.error = copy.editLimit
      return false
    }
    this.error = ''
    return true
  }
  get editorScroll(): ReturnType<EditorView['scrollSnapshot']> | undefined { return this.editorScrollState }
  setEditorScroll(snapshot: ReturnType<EditorView['scrollSnapshot']>): void { this.editorScrollState = snapshot }
  configureView(extensions: () => Extension): void {
    if (this.viewConfigured) return
    this.dispatch({ effects: StateEffect.appendConfig.of(extensions()) })
    this.viewConfigured = true
  }
  setFrozen(value: boolean): void { this.frozen = value }
  get currentRevision(): number { return this.revision }
  get state(): EditorState { return this.current }
  get dirty(): boolean { return this.document.displayPath ? this.document.recovered || this.current.doc.toString() !== this.baseline : this.current.doc.length !== 0 }
  snapshot(): ContentSnapshot { return { docId: this.document.docId, epoch: this.document.epoch, revision: this.revision, text: this.current.doc.toString() } }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeHistoryRestore(listener: (transaction: Transaction) => void): () => void { this.restoreListeners.add(listener); return () => this.restoreListeners.delete(listener) }
  apply(transactions: readonly Transaction[]): readonly Transaction[] {
    // History commands use filter:false. Enforce the boundary again before installing any state.
    if (transactions.some((transaction) => !this.allows(transaction))) transactions = [this.current.update({})]
    for (const transaction of transactions) {
      if (transaction.startState !== this.current) throw new Error('Transaction belongs to another state')
      this.current = transaction.state
      if (transaction.docChanged) this.revision++
    }
    for (const listener of this.listeners) listener()
    return transactions
  }
  dispatch(spec: TransactionSpec): void { this.apply([this.current.update(spec)]) }
  captureSave(requestId: string): ContentSnapshot {
    const existing = this.submitted.get(requestId)
    if (existing) return { ...existing.snapshot }
    const snapshot = this.snapshot()
    this.submitted.set(requestId, { snapshot, order: ++this.nextSaveOrder })
    return { ...snapshot }
  }
  saveOrder(requestId: string): number | undefined { return this.submitted.get(requestId)?.order }
  abandonSave(requestId: string): void {
    this.submitted.delete(requestId); this.restoreTargets.delete(requestId)
    if (this.restoreHold === requestId) this.restoreHold = null
    if (this.saveHold === requestId) this.saveHold = null
  }
  holdHistoryRestore(requestId: string): void {
    if (this.submitted.has(requestId) && this.restoreTargets.has(requestId)) this.restoreHold = requestId
  }
  captureHistoryRestore(requestId: string, target: HistorySnapshot): ContentSnapshot | null {
    if (!this.frozen || this.document.readOnlyReason || !target.restorable || !target.format || this.restoreTargets.size || this.submitted.has(requestId)) return null
    const snapshot = this.captureSave(requestId)
    this.restoreTargets.set(requestId, { ...target, format: { ...target.format } })
    return snapshot
  }
  acceptHistoryRestore(receipt: HistoryRestoreReceipt): boolean {
    const attempt = this.submitted.get(receipt.requestId); const target = this.restoreTargets.get(receipt.requestId)
    const saved = receipt.restored
    const sameRef = (ref: { docId: string; epoch: string }) => ref.docId === this.document.docId && ref.epoch === this.document.epoch
    const preserved = receipt.preservedCurrent
    if (!attempt || !target || !this.frozen || this.document.readOnlyReason || !this.document.format || attempt.order < this.acceptedSaveOrder ||
      !sameRef(receipt.ref) || !sameRef(saved.ref) || saved.requestId !== receipt.requestId || receipt.historyId !== target.id || receipt.contentHash !== target.contentHash ||
      receipt.previousRevision !== attempt.snapshot.revision || this.revision !== attempt.snapshot.revision || this.current.doc.toString() !== attempt.snapshot.text ||
      !Number.isSafeInteger(saved.savedRevision) || saved.savedRevision !== receipt.previousRevision + 1 || saved.displayPath !== this.document.displayPath || saved.displayName !== this.document.displayName ||
      !/^[a-f0-9]{64}$/u.test(saved.diskToken) || preserved && (!sameRef(preserved.ref) || preserved.requestId !== receipt.requestId || preserved.savedRevision !== receipt.previousRevision || preserved.displayPath !== this.document.displayPath)) return false
    const bytes = new TextEncoder().encode(target.text).length + (this.document.format.bom ? 3 : 0) + (this.document.format.eol === 'crlf' ? target.text.split('\n').length - 1 : 0)
    if (bytes > EDITABLE_DOCUMENT_MAX_BYTES || target.text.includes('\r') || target.text === attempt.snapshot.text) return false
    // Only this validated operation can bypass the frozen transaction filter. No public force flag.
    const transaction = this.current.update({ changes: { from: 0, to: this.current.doc.length, insert: target.text }, annotations: isolateHistory.of('full'), filter: false })
    this.current = transaction.state
    this.revision = this.savedRevision = saved.savedRevision
    this.baseline = target.text; this.acceptedSaveOrder = attempt.order
    this.document.recovered = false; this.document.diskToken = saved.diskToken
    this.abandonSave(receipt.requestId)
    // A lost reply can leave the original editor mounted. Advance that view with
    // this exact validated transaction before any observer can thaw or reuse it.
    for (const listener of this.restoreListeners) listener(transaction)
    for (const listener of this.listeners) listener()
    return true
  }
  bindSaveReceipt(localRequestId: string, receipt: SaveReceipt, savedText: string): boolean {
    const pending = this.submitted.get(localRequestId)
    if (!pending || this.submitted.has(receipt.requestId) || pending.snapshot.docId !== receipt.ref.docId || pending.snapshot.epoch !== receipt.ref.epoch || pending.snapshot.revision !== receipt.savedRevision || pending.snapshot.text !== savedText) return false
    this.submitted.set(receipt.requestId, pending); this.submitted.delete(localRequestId)
    return true
  }
  acceptSave(receipt: SaveReceipt, savedText: string): boolean {
    const attempt = this.submitted.get(receipt.requestId)
    const submitted = attempt?.snapshot
    if (!submitted || receipt.ref.docId !== this.document.docId || receipt.ref.epoch !== this.document.epoch || receipt.savedRevision !== submitted.revision || savedText !== submitted.text) return false
    this.submitted.delete(receipt.requestId)
    if (this.saveHold === receipt.requestId) this.saveHold = null
    if (receipt.savedRevision < this.savedRevision || attempt!.order < this.acceptedSaveOrder) return false
    this.acceptedSaveOrder = attempt!.order
    this.savedRevision = receipt.savedRevision
    this.baseline = submitted.text
    this.document.recovered = false
    this.document.diskToken = receipt.diskToken
    this.document.displayName = receipt.displayName
    this.document.displayPath = receipt.displayPath
    for (const listener of this.listeners) listener()
    return true
  }
}
