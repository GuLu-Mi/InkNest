import { copy } from '../../../shared/copy'
import type { ContentSnapshot, Result, SessionRef } from '../../../shared/contracts'
import type { WorkspaceModel, TabState } from './workspace'
interface Pending { revision: number; idle: ReturnType<typeof setTimeout> | null; max: ReturnType<typeof setTimeout> | null; running: boolean }
/** Independent from formal save. Never snapshots readonly text or selection-only changes. */
export class RecoveryScheduler {
  private readonly pending = new Map<TabState, Pending>()
  private readonly unsubscribe: () => void
  private disposed = false
  constructor(private readonly workspace: WorkspaceModel, private readonly checkpoint: (snapshot: ContentSnapshot) => Promise<Result<{ revision: number; savedAt: string }>>, private readonly ready: (ref: SessionRef) => Promise<boolean> = async () => true) { this.unsubscribe = workspace.subscribe(() => this.sync()); this.sync() }
  private cancel(state: Pending): void { if (state.idle) clearTimeout(state.idle); if (state.max) clearTimeout(state.max); state.idle = state.max = null }
  private sync(): void {
    for (const [tab, state] of this.pending) if (this.workspace.getTab(tab.document) !== tab) { this.cancel(state); this.pending.delete(tab) }
    for (const ref of this.workspace.refs) {
      const tab = this.workspace.getTab(ref)!; const session = tab.session; if (!session) continue
      let state = this.pending.get(tab)
      if (!state) { state = { revision: session.currentRevision, idle: null, max: null, running: false }; this.pending.set(tab, state); continue }
      if (!session.dirty) { this.cancel(state); state.revision = session.currentRevision; tab.recoveryStatus = null; continue }
      if (state.revision === session.currentRevision) continue
      state.revision = session.currentRevision; tab.recoveryStatus = 'pending'; tab.recoveryError = ''
      if (state.idle) clearTimeout(state.idle)
      state.idle = setTimeout(() => { void this.run(tab, state) }, 2000)
      state.max ??= setTimeout(() => { void this.run(tab, state) }, 10000)
    }
  }
  retry(ref: SessionRef, allowed: () => boolean = () => true): Promise<void> {
    const tab = this.workspace.getTab(ref); const state = tab && this.pending.get(tab)
    if (!tab || !state) return Promise.resolve()
    return this.run(tab, state, () => !tab.frozen && !tab.session?.frozen && allowed())
  }
  private async run(tab: TabState, state: Pending, allowed: () => boolean = () => true): Promise<void> {
    if (state.running || !allowed()) return
    this.cancel(state)
    if (this.disposed || this.workspace.getTab(tab.document) !== tab || !tab.session?.dirty) return
    state.running = true
    let attemptedRevision: number | null = null
    try {
      if (!await this.ready(tab.document)) { state.idle ??= setTimeout(() => { void this.run(tab, state, allowed) }, 2000); return }
      if (this.disposed || this.workspace.getTab(tab.document) !== tab || !tab.session.dirty || !allowed()) return
      const snapshot = tab.session.snapshot(); attemptedRevision = snapshot.revision
      const result = await this.checkpoint(snapshot)
      if (this.disposed || this.workspace.getTab(tab.document) !== tab || tab.session.currentRevision !== snapshot.revision || !tab.session.dirty) return
      if (result.status === 'ok' && result.value.revision === snapshot.revision) { tab.recoveryStatus = 'backed-up'; tab.recoveryRevision = snapshot.revision; tab.recoveryError = '' }
      else { tab.recoveryStatus = 'error'; tab.recoveryError = result.status === 'error' ? result.error.message : copy.recoveryIncomplete }
      this.workspace.changed()
    } catch { if (this.workspace.getTab(tab.document) === tab) { tab.recoveryStatus = 'error'; tab.recoveryError = copy.recoveryFailedRetained; this.workspace.changed() } }
    finally { state.running = false; if (!this.disposed && attemptedRevision !== null && tab.session.currentRevision !== attemptedRevision) state.idle ??= setTimeout(() => { void this.run(tab, state) }, 0) }
  }

  dispose(): void { this.disposed = true; this.unsubscribe(); for (const state of this.pending.values()) this.cancel(state); this.pending.clear() }
}
