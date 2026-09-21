import { copy } from '../../../shared/copy'
import type { AppEvent, ContentSnapshot, DiskStatus, HistoryCommit, HistoryRestoreReceipt, OpenDocument, SaveReceipt, SessionRef, TabViewState } from '../../../shared/contracts'
import { DocumentSession } from './session'
export interface TabState {
  document: OpenDocument
  session: DocumentSession | null
  copySession: DocumentSession | null
  recoveryStatus: 'pending' | 'backed-up' | 'error' | null
  recoveryRevision: number | null
  recoveryError: string
  recoveryPending: boolean
  historyAttention: HistoryCommit | null
  historyGeneration: number
  historyMaintenance: boolean
  notice: string
  view: TabViewState
  diskStatus: DiskStatus
  inspection: string | null
  error: string
  saving: number
  frozen: boolean
  saveOutcome: { requestId: string; order: number } | null
  saveError: string | null
  saveFailure: 'failure' | 'conflict' | null
  unsubscribe: () => void
}
const key = (ref: SessionRef) => `${ref.docId}/${ref.epoch}`
/** Owns session lifetimes; switching never reinstalls text or CodeMirror history. */
export class WorkspaceModel {
  private readonly tabs = new Map<string, TabState>()
  private readonly listeners = new Set<() => void>()
  private selected: SessionRef | null = null
  get refs(): readonly SessionRef[] { return [...this.tabs.values()].map(({ document }) => ({ docId: document.docId, epoch: document.epoch })) }
  get active(): SessionRef | null { return this.selected }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  changed(): void { for (const listener of this.listeners) listener() }
  install(document: OpenDocument): void { this.register(document); this.activate(document) }
  register(document: OpenDocument): void {
    if (!this.tabs.has(key(document))) {
      const session = document.readOnlyReason ? null : new DocumentSession(document)
      const tab: TabState = { document, session, copySession: null, recoveryStatus: document.recovered ? 'backed-up' : null, recoveryRevision: document.recovered ? document.revision : null, recoveryError: '', recoveryPending: document.recovered, historyAttention: null, historyGeneration: 0, historyMaintenance: false, notice: '', view: { mode: 'read', reading: { top: document.readingPosition?.offset ?? 0, ratio: document.readingPosition?.ratio ?? 0, revision: document.revision }, editorTop: 0 }, diskStatus: 'current', inspection: null, error: '', saving: 0, frozen: false, saveOutcome: null, saveError: null, saveFailure: null, unsubscribe: () => {} }
      tab.unsubscribe = session?.subscribe(() => { if (session.error) tab.error = session.error; if (tab.recoveryPending && session.currentRevision > tab.document.revision) tab.recoveryPending = false; this.changed() }) ?? (() => {})
      this.tabs.set(key(document), tab)
    }
    this.changed()
  }
  replace(ref: SessionRef, document: OpenDocument): void {
    const previous = this.getTab(ref)
    if (!previous || document.docId !== ref.docId || document.epoch === ref.epoch) return
    const selected = this.selected && key(this.selected) === key(ref)
    const oldTabs = [...this.tabs.values()]
    this.register(document)
    const next = this.getTab(document)!
    next.view = { ...previous.view, reading: { ...previous.view.reading, revision: -1 } }
    previous.unsubscribe()
    // Keep tab order and the selection when a background epoch is replaced.
    this.tabs.clear()
    for (const tab of oldTabs) this.tabs.set(key(tab === previous ? document : tab.document), tab === previous ? next : tab)
    if (selected) this.selected = { docId: document.docId, epoch: document.epoch }
    this.changed()
  }
  canSaveAs(ref: SessionRef): boolean {
    const tab = this.getTab(ref)
    return !!tab && (!!tab.session || !!tab.document.format && (tab.document.readOnlyReason === 'link' || tab.document.readOnlyReason === 'permission'))
  }
  captureSaveAs(ref: SessionRef, requestId: string): ContentSnapshot | null {
    const tab = this.getTab(ref)
    if (!tab || !this.canSaveAs(ref)) return null
    if (tab.session) return tab.session.captureSave(requestId)
    tab.copySession ??= new DocumentSession(tab.document)
    return tab.copySession.captureSave(requestId)
  }
  finishSaveAs(ref: SessionRef): void { const tab = this.getTab(ref); if (tab) tab.copySession = null }
  acceptSave(receipt: SaveReceipt, savedText: string): boolean {
    const tab = this.getTab(receipt.ref)
    const session = tab?.session ?? tab?.copySession
    const order = session?.saveOrder(receipt.requestId)
    const previousPath = tab?.document.displayPath
    if (!tab || !session || order === undefined || !session.acceptSave(receipt, savedText)) return false
    if (previousPath !== receipt.displayPath) { tab.historyGeneration = 0; tab.historyMaintenance = false }
    if (tab.copySession === session) {
      tab.document.readOnlyReason = null; tab.session = session; tab.copySession = null
      session.setFrozen(tab.frozen)
      tab.unsubscribe = session.subscribe(() => { if (session.error) tab.error = session.error; if (tab.recoveryPending && session.currentRevision > tab.document.revision) tab.recoveryPending = false; this.changed() })
    }
    if (order >= (tab.saveOutcome?.order ?? 0)) {
      tab.saveOutcome = { requestId: receipt.requestId, order }
      tab.saveError = null; tab.saveFailure = null
      this.historyOutcome(tab, receipt.history)
    }
    tab.recoveryPending = false
    this.changed()
    return true
  }
  acceptHistoryRestore(receipt: HistoryRestoreReceipt): boolean {
    const tab = this.getTab(receipt.ref); const session = tab?.session
    const order = session?.saveOrder(receipt.requestId)
    if (!tab || !session || order === undefined || !session.acceptHistoryRestore(receipt)) return false
    tab.saveOutcome = { requestId: receipt.requestId, order }
    this.historyOutcome(tab, receipt.restored.history)
    tab.saveError = null; tab.saveFailure = null; tab.recoveryPending = false; tab.diskStatus = 'current'; tab.error = ''
    this.changed()
    return true
  }
  private historyOutcome(tab: TabState, history: HistoryCommit | undefined): void {
    if (!history) return
    tab.historyGeneration = Math.max(tab.historyGeneration, history.generation)
    tab.historyAttention = history.state === 'failed' || history.state === 'skipped' ? history : null
  }
  acceptHistoryChange(event: Extract<AppEvent, { type: 'history-changed' }>): void {
    const tab = this.getTab(event.ref)
    if (!tab || event.displayPath !== tab.document.displayPath || event.generation <= tab.historyGeneration) return
    tab.historyGeneration = event.generation; this.changed()
  }
  acceptRecovery(event: Extract<AppEvent, { type: 'recovery-status' }> | { ref: SessionRef; revision: number; state: 'pending' | 'backed-up' | 'error' }): boolean {
    const tab = this.getTab(event.ref)
    if (!tab?.session || tab.session.currentRevision !== event.revision || event.state === 'backed-up' && !tab.session.dirty) return false
    tab.recoveryStatus = event.state
    if (event.state === 'backed-up') { tab.recoveryRevision = event.revision; tab.recoveryError = '' }
    if (event.state === 'error') tab.recoveryError = copy.recoveryMaintenanceFailed
    this.changed(); return true
  }
  failSave(ref: SessionRef, requestId: string, failure: 'failure' | 'conflict', message: string): boolean {
    const tab = this.getTab(ref)
    const session = tab?.session ?? tab?.copySession
    const order = session?.saveOrder(requestId)
    if (!tab || order === undefined) return false
    session?.abandonSave(requestId)
    if (order < (tab.saveOutcome?.order ?? 0)) return false
    tab.saveOutcome = { requestId, order }; tab.saveFailure = failure; tab.saveError = message
    this.changed()
    return true
  }
  activate(ref: SessionRef): void { if (this.tabs.has(key(ref))) { this.selected = { docId: ref.docId, epoch: ref.epoch }; this.changed() } }
  remove(ref: SessionRef): void {
    const tab = this.tabs.get(key(ref)); if (!tab) return
    tab.unsubscribe(); this.tabs.delete(key(ref))
    if (this.selected && key(this.selected) === key(ref)) this.selected = this.refs.at(-1) ?? null
    this.changed()
  }
  getTab(ref: SessionRef): TabState | null { return this.tabs.get(key(ref)) ?? null }
  get(ref: SessionRef): OpenDocument | null { return this.getTab(ref)?.document ?? null }
  getSession(ref: SessionRef): DocumentSession | null { return this.getTab(ref)?.session ?? null }
  getView(ref: SessionRef): TabViewState { const tab = this.getTab(ref); if (!tab) throw new Error('Unknown document'); return tab.view }
  setView(ref: SessionRef, patch: Partial<TabViewState>): void { const tab = this.getTab(ref); if (tab) { Object.assign(tab.view, patch); this.changed() } }
  dispose(): void { for (const ref of this.refs) this.remove(ref); this.listeners.clear() }
}
