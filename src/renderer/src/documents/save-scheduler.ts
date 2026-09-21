import type { SaveReason, SessionRef } from '../../../shared/contracts'
interface Pending {
  ref: SessionRef
  idle: ReturnType<typeof setTimeout> | null
  max: ReturnType<typeof setTimeout> | null
  changed: boolean
  due: boolean
  composing: boolean
  paused: boolean
  suspended: boolean
  running: Promise<boolean> | null
  flushing: number
  nextOrder: number
  outcomeOrder: number
}
/** One automatic submission and one latest-change marker per full session identity. */
export class SaveScheduler {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly options: { save: (ref: SessionRef, reason: SaveReason) => Promise<boolean>; idleMs: number; maxWaitMs: number }) {}
  private key(ref: SessionRef): string { return `${ref.docId}/${ref.epoch}` }
  private state(ref: SessionRef): Pending {
    let state = this.pending.get(this.key(ref))
    if (!state) { state = { ref: { docId: ref.docId, epoch: ref.epoch }, idle: null, max: null, changed: false, due: false, composing: false, paused: false, suspended: false, running: null, flushing: 0, nextOrder: 0, outcomeOrder: 0 }; this.pending.set(this.key(ref), state) }
    return state
  }
  private live(state: Pending): boolean { return this.pending.get(this.key(state.ref)) === state }
  private cancel(state: Pending): void { if (state.idle !== null) clearTimeout(state.idle); if (state.max !== null) clearTimeout(state.max); state.idle = state.max = null }
  changed(ref: SessionRef): void {
    const state = this.state(ref); state.changed = true
    if (state.paused || state.suspended) return
    if (state.idle !== null) clearTimeout(state.idle)
    state.idle = setTimeout(() => this.deadline(state), this.options.idleMs)
    state.max ??= setTimeout(() => this.deadline(state), this.options.maxWaitMs)
  }
  private deadline(state: Pending): void { this.cancel(state); state.due = true; if (!state.flushing) void this.run(state, 'auto') }
  composition(ref: SessionRef, active: boolean): void { const state = this.state(ref); state.composing = active; if (!active && state.due && !state.flushing) void this.run(state, 'auto') }
  private async run(state: Pending, reason: SaveReason): Promise<boolean> {
    if (!this.live(state) || state.running || state.composing || state.paused || state.suspended && (reason === 'auto' || reason === 'mode-change')) return false
    this.cancel(state); state.changed = false; state.due = false
    const order = ++state.nextOrder
    const running = Promise.resolve().then(() => this.options.save(state.ref, reason)).catch(() => false)
    state.running = running
    const ok = await running; state.running = null
    if (!this.live(state)) return ok
    this.outcome(state, order, ok)
    if (ok && state.due && state.changed && !state.flushing) void this.run(state, 'auto')
    return ok
  }
  private outcome(state: Pending, order: number, ok: boolean): void {
    if (!this.live(state) || order < state.outcomeOrder) return
    state.outcomeOrder = order; state.paused = !ok
    if (!ok) { state.changed = true; this.cancel(state) }
  }
  async flush(ref: SessionRef, reason: SaveReason): Promise<boolean> {
    const state = this.state(ref); const explicit = reason === 'manual' || reason === 'close'
    if (state.paused && !explicit) return false
    state.flushing++
    try {
      this.cancel(state)
      while (state.running) await state.running
      if (!this.live(state)) return false
      if (!explicit && !state.changed) return true
      if (!explicit) return await this.run(state, reason)
      if (state.composing) return false
      // Main drains each accepted manual in FIFO, while renderer replies may arrive out of order.
      state.paused = false; state.changed = false; state.due = false
      const order = ++state.nextOrder
      const ok = await Promise.resolve().then(() => this.options.save(state.ref, reason)).catch(() => false)
      this.outcome(state, order, ok)
      return ok
    } finally {
      state.flushing--
      if (this.live(state) && !state.flushing && state.due && state.changed) void this.run(state, 'auto')
    }
  }
  /** Workspace eligibility blocks timers without releasing an already accepted request. */
  suspend(ref: SessionRef, active: boolean): void { const state = this.state(ref); state.suspended = active; if (active) this.cancel(state) }
  /** Only an explicit permitted user action should resume failed work. */
  resume(ref: SessionRef): void { const state = this.state(ref); state.paused = false; if (state.changed) this.changed(ref) }
  dispose(ref: SessionRef): void { const key = this.key(ref); const state = this.pending.get(key); if (state) this.cancel(state); this.pending.delete(key) }
}

/** Receipts/selection/scroll notify the workspace too; only revisions start a new deadline. */
export function observeSaveChanges(workspace: import('./workspace').WorkspaceModel, scheduler: SaveScheduler, workspaceFrozen: () => boolean = () => false): () => void {
  const observed = new Map<import('./workspace').TabState, { revision: number; eligible: boolean }>()
  const sync = () => {
    for (const [tab] of observed) if (workspace.getTab(tab.document) !== tab) { scheduler.dispose(tab.document); observed.delete(tab) }
    for (const ref of workspace.refs) {
      const tab = workspace.getTab(ref)!; const session = tab.session
      if (!session) continue
      const eligible = !workspaceFrozen() && !tab.frozen && !tab.recoveryPending && !tab.saveFailure && !tab.historyAttention && tab.diskStatus === 'current' && !!tab.document.displayPath
      const previous = observed.get(tab)
      observed.set(tab, { revision: session.currentRevision, eligible })
      if (!eligible) { scheduler.suspend(ref, true); continue }
      if (!previous) continue
      if (!previous.eligible) { scheduler.suspend(ref, false); scheduler.resume(ref) }
      if (previous.revision !== session.currentRevision || session.dirty && !previous.eligible) scheduler.changed(ref)
    }
  }
  const unsubscribe = workspace.subscribe(sync); sync()
  return () => { unsubscribe(); for (const tab of observed.keys()) scheduler.dispose(tab.document); observed.clear() }
}
