import { pendingHistoryRestore, retryHistoryRestoreReceipt as retryHistoryRestoreAction, restoreHistory as restoreHistoryAction } from './history-actions'
import { copy } from '../../../shared/copy'
import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import type { ConflictAction, ContentSnapshot, LinkOutcome, Result, HistorySnapshot, Mode, OpenDocument, SaveReason, SaveRequest, SessionRef } from '../../../shared/contracts'
import { SaveScheduler, observeSaveChanges } from './save-scheduler'
import { RecoveryScheduler } from './recovery-scheduler'
import { WorkspaceModel, type TabState } from './workspace'
export interface ActiveEditor { settleComposition(): Promise<boolean>; setFrozen(value: boolean): void; focus?(): void }
const same = (a: SessionRef | null, b: SessionRef) => a?.docId === b.docId && a.epoch === b.epoch
export function useWorkspace(editor: Ref<ActiveEditor | undefined>, surface: { canCreate?: () => boolean; saveAs?: () => Promise<boolean>; presentation?: () => Promise<void>; find?: (command: 'find' | 'find-next' | 'find-previous') => Promise<void> } = {}) {
  const workspace = new WorkspaceModel()
  const signal = ref(0); const busy = ref(false); const workspaceFrozen = ref(false); const globalError = ref('')
  const backupsOpen = ref(false)
  const recoveryScheduler = new RecoveryScheduler(workspace, snapshot => window.inknest.checkpoint(snapshot), async ref => !same(workspace.active, ref) || await editor.value?.settleComposition() !== false)
  const saveScheduler = new SaveScheduler({ save: saveSnapshot, idleMs: 1000, maxWaitMs: 10000 })
  const stopAutosave = observeSaveChanges(workspace, saveScheduler, () => workspaceFrozen.value)
  const unsubscribe = workspace.subscribe(() => signal.value++)
  const tabs = computed(() => { void signal.value; return workspace.refs.map(ref => workspace.getTab(ref)!) })
  const tab = computed(() => { void signal.value; return workspace.active ? workspace.getTab(workspace.active) : null })
  const document = computed(() => { void signal.value; return tab.value ? { ...tab.value.document, ...tab.value.session?.snapshot() } : null })
  const session = computed(() => { void signal.value; return tab.value?.session ?? null })
  const canSaveAs = computed(() => { void signal.value; return !!tab.value && workspace.canSaveAs(tab.value.document) })
  const dirty = computed(() => { void signal.value; return session.value?.dirty ?? false })
  const error = computed(() => { void signal.value; return tab.value?.error || tab.value?.saveError || globalError.value })
  const frozen = computed(() => { void signal.value; return workspaceFrozen.value || (tab.value?.frozen ?? false) })
  const historyRestorePending = computed(() => { void signal.value; return pendingHistoryRestore(workspace) })
  const editingFrozen = computed(() => { void signal.value; return frozen.value || (session.value?.frozen ?? false) })
  const mode = computed(() => { void signal.value; return tab.value?.view.mode ?? 'read' })
  let openingSelections: Map<string, Promise<void>> | null = null
  const createdSelections = new Map<string, Promise<void>>()
  const pendingSaveAs = new Map<TabState, SaveRequest>()
  let freezeId: string | null = null
  let freezeReady = Promise.resolve(true)
  const lifecycleOperations = new Map<TabState, Promise<void>>()
  const pendingExternal = new Map<string, SessionRef>()
  const closeOwners = new WeakMap<TabState, string>()
  const finishedCloses = new Set<string>()
  const closing = new Map<string, { ref: SessionRef; snapshot: ContentSnapshot | null; single: boolean }>()
  async function settle(): Promise<boolean> {
    const origin = tab.value
    if (await editor.value?.settleComposition() === false) {
      if (origin) origin.error = copy.compositionPending
      workspace.changed(); return false
    }
    return true
  }
  function install(value: OpenDocument, selections: Map<string, Promise<void>> | null): Promise<void> {
    // Main has already registered this session. Composition may defer selection, never registration.
    workspace.register(value)
    if (workspaceFrozen.value) {
      const state = workspace.getTab(value)!
      state.frozen = true; state.session?.setFrozen(true)
      return Promise.resolve()
    }
    const key = `${value.docId}/${value.epoch}`
    const previous = selections?.get(key)
    if (previous) return previous
    const selection = (async () => {
      if ((same(workspace.active, value) || await settle()) && !workspaceFrozen.value) workspace.activate(value)
    })()
    selections?.set(key, selection)
    return selection
  }
  const linkedReceipts = new Set<string>()
  function installCreated(value: OpenDocument): Promise<void> {
    const key = `${value.docId}/${value.epoch}`
    const previous = createdSelections.get(key)
    if (previous) return previous
    const selection = install(value, null)
    createdSelections.set(key, selection)
    if (createdSelections.size > 256) createdSelections.delete(createdSelections.keys().next().value!)
    return selection
  }
  function receiveLinked(requestId: string, value: OpenDocument): void {
    if (linkedReceipts.has(requestId)) return
    linkedReceipts.add(requestId)
    if (linkedReceipts.size > 256) linkedReceipts.delete(linkedReceipts.values().next().value!)
    workspace.register(value)
  }
  async function openLinked(rawTarget: string, accept: () => boolean): Promise<Result<LinkOutcome>> {
    const origin = document.value
    if (!origin || frozen.value || !await settle() || !accept()) return { status: 'cancelled' }
    const requestId = crypto.randomUUID()
    try {
      const result = await window.inknest.openDocumentLink({ requestId, ref: { docId: origin.docId, epoch: origin.epoch }, rawTarget })
      if (result.status === 'ok' && result.value.kind === 'document') {
        receiveLinked(requestId, result.value.document)
        if (!accept() || workspaceFrozen.value || !workspace.getTab(result.value.document)) return { status: 'cancelled' }
        const activated = await window.inknest.activateDocument({ docId: result.value.document.docId, epoch: result.value.document.epoch })
        if (activated.status !== 'ok') return activated
        if (accept() && !workspaceFrozen.value) workspace.activate(result.value.document)
        return same(workspace.active, result.value.document) ? result : { status: 'cancelled' }
      }
      return accept() ? result : { status: 'cancelled' }
    } catch { return accept() ? { status: 'error', error: { code: 'IO_ERROR', message: '链接打开失败，请重试', retryable: true } } : { status: 'cancelled' } }
  }
  async function activate(ref: SessionRef): Promise<void> {
    if (frozen.value || same(workspace.active, ref) || !await settle()) return
    const origin = tab.value
    const result = await window.inknest.activateDocument({ docId: ref.docId, epoch: ref.epoch })
    if (result.status === 'ok' && !workspaceFrozen.value) workspace.activate(ref)
    else if (result.status === 'error' && origin) { origin.error = result.error.message; workspace.changed() }
  }
  async function setMode(value: Mode): Promise<void> {
    const origin = tab.value
    if (!origin || frozen.value || !await settle() || tab.value !== origin) return
    workspace.setView(origin.document, { mode: value })
    if (value === 'read') await saveScheduler.flush(origin.document, 'mode-change')
  }
  async function openFile(): Promise<void> {
    if (busy.value || frozen.value || !await settle()) return
    busy.value = true; globalError.value = ''; const origin = tab.value
    const selections = openingSelections = new Map<string, Promise<void>>()
    if (origin) origin.error = ''
    try {
      const result = await window.inknest.openFile()
      if (result.status === 'ok') await install(result.value, selections)
      else if (result.status === 'error') { if (origin) origin.error = result.error.message; else globalError.value = result.error.message }
    } catch { if (origin) origin.error = copy.openFailedRetained; else globalError.value = copy.openFailed }
    finally { openingSelections = null; busy.value = false; workspace.changed() }
  }
  async function showHome(): Promise<boolean> {
    if (busy.value || editingFrozen.value || surface.canCreate?.() === false) return false
    busy.value = true
    const origin = tab.value
    try {
      if (!await settle()) {
        if (tab.value === origin && !editingFrozen.value) editor.value?.focus?.()
        return false
      }
      if (tab.value !== origin || editingFrozen.value || surface.canCreate?.() === false) return false
      if (origin?.error === copy.compositionPending) origin.error = ''
      workspace.showHome()
      globalError.value = ''
      return true
    } finally { busy.value = false }
  }
  async function createDocument(): Promise<void> {
    if (busy.value || editingFrozen.value || surface.canCreate?.() === false) return
    busy.value = true
    const origin = tab.value
    try {
      if (!await settle() || editingFrozen.value || surface.canCreate?.() === false) return
      globalError.value = ''; if (origin) origin.error = ''
      const result = await window.inknest.createDocument()
      if (result.status === 'ok') await installCreated(result.value)
      else if (result.status === 'error') { if (origin) origin.error = result.error.message; else globalError.value = result.error.message }
    } catch { if (origin) origin.error = copy.newFailed; else globalError.value = copy.newFailed }
    finally { busy.value = false; workspace.changed() }
  }
  async function closeDocument(ref: SessionRef): Promise<void> {
    const origin = workspace.getTab(ref)
    if (!origin || workspaceFrozen.value || origin.frozen) return
    try {
      const result = await window.inknest.closeDocument({ docId: ref.docId, epoch: ref.epoch })
      if (result.status === 'error' && result.error.code === 'STALE_SESSION' && workspace.getTab(ref) === origin) { origin.error = result.error.message; workspace.changed() }
    } catch { if (workspace.getTab(ref) === origin) { origin.error = copy.closeFailed; workspace.changed() } }
  }
  async function retryRecovery(): Promise<void> {
    const origin = tab.value
    if (!origin || frozen.value) return
    await recoveryScheduler.retry(origin.document, () => !workspaceFrozen.value && workspace.getTab(origin.document) === origin)
  }
  async function save(): Promise<void> {
    const origin = tab.value
    if (!origin?.session || frozen.value || !await settle() || origin.frozen) return
    if (!origin.document.displayPath || pendingSaveAs.has(origin)) return saveAs()
    await saveScheduler.flush(origin.document, 'manual')
  }
  async function saveSnapshot(ref: SessionRef, reason: SaveReason): Promise<boolean> {
    const origin = workspace.getTab(ref); const current = workspace.getSession(ref)
    const automatic = reason === 'auto' || reason === 'mode-change'
    if (!origin || !current || workspaceFrozen.value || origin.frozen) return true
    if (automatic && (!current.dirty || origin.recoveryPending || origin.saveFailure || origin.historyAttention || origin.diskStatus !== 'current' || !origin.document.displayPath)) return true
    if (same(workspace.active, ref) && !await settle()) { saveScheduler.changed(ref); return true }
    if (workspace.getTab(ref) !== origin || workspaceFrozen.value || origin.frozen) return true
    closeOwners.delete(origin)
    const requestId = crypto.randomUUID(); const snapshot = current.captureSave(requestId)
    origin.saving++; workspace.changed()
    try {
      const result = await window.inknest.save({ requestId, snapshot, expectedDiskToken: current.document.diskToken, trigger: automatic ? 'auto' : 'manual' })
      if (workspace.getTab(ref) !== origin) return true
      // Rejecting an obsolete receipt protects the baseline; it is not a new save failure.
      if (result.status === 'ok') { workspace.acceptSave(result.value, snapshot.text); return !origin.historyAttention }
      if (result.status === 'error') {
        const accepted = workspace.failSave(ref, requestId, result.error.code === 'EXTERNAL_CHANGE' ? 'conflict' : 'failure', result.error.message)
        if (accepted && result.error.code === 'EXTERNAL_CHANGE') origin.diskStatus = 'changed'
        return !accepted
      }
      current.abandonSave(requestId)
      // Main can decline autos during a user-action barrier. Retain latest text, retry later.
      if (automatic && current.dirty) saveScheduler.changed(ref)
      return true
    } catch { return !workspace.failSave(ref, requestId, 'failure', copy.saveFailedRetained) }
    finally { origin.saving--; workspace.changed() }
  }
  function freezeTab(origin: TabState, value: boolean): void {
    origin.frozen = value; origin.session?.setFrozen(value)
    if (tab.value === origin) editor.value?.setFrozen(origin.session?.frozen ?? value)
    workspace.changed()
  }
  const hasClosing = (origin: TabState) => [...closing.values()].some(request => same(request.ref, origin.document))
  function drainExternal(origin: TabState): void {
    if (workspaceFrozen.value || hasClosing(origin) || lifecycleOperations.has(origin)) return
    const ref = pendingExternal.get(origin.document.docId)
    if (ref) { pendingExternal.delete(ref.docId); void reconcile(ref) }
  }
  function runFrozen(origin: TabState, operation: () => Promise<void | false>, keepCloseOwner = false): Promise<void> {
    const existing = lifecycleOperations.get(origin)
    if (existing) return existing
    let drain = false
    const running = (async () => {
      if (workspaceFrozen.value || hasClosing(origin)) return
      if (same(workspace.active, origin.document) && !await settle()) return
      if (workspaceFrozen.value || hasClosing(origin) || workspace.getTab(origin.document) !== origin) return
      if (!keepCloseOwner) closeOwners.delete(origin)
      // No await between freezing and the operation's capture of CurrentState.
      freezeTab(origin, true)
      try { drain = await operation() !== false }
      catch { if (workspace.getTab(origin.document) === origin) origin.error = copy.actionFailed }
      finally { if (workspace.getTab(origin.document) === origin && !workspaceFrozen.value && !hasClosing(origin)) freezeTab(origin, false) }
    })()
    lifecycleOperations.set(origin, running)
    void running.finally(() => {
      lifecycleOperations.delete(origin)
      if (drain) drainExternal(origin)
    })
    return running
  }
  function reconcile(ref: SessionRef): Promise<void> {
    const origin = workspace.getTab(ref)
    if (!origin || !origin.document.displayPath) return Promise.resolve()
    pendingExternal.set(ref.docId, ref)
    if (workspaceFrozen.value || hasClosing(origin) || lifecycleOperations.has(origin) || same(historyRestorePending.value?.ref ?? null, ref)) return Promise.resolve()
    return runFrozen(origin, async () => {
      pendingExternal.delete(ref.docId)
      const state = { ref: { docId: ref.docId, epoch: ref.epoch }, snapshot: origin.session?.snapshot() ?? null }
      const result = await window.inknest.reconcileExternal(state)
      if (workspace.getTab(ref) !== origin) return
      if (result.status === 'ok') {
        if (result.value.kind === 'reloaded') { workspace.replace(ref, result.value.document); workspace.getTab(result.value.document)!.notice = copy.fileUpdated }
        else if (result.value.kind === 'conflict') { origin.diskStatus = result.value.diskStatus; origin.inspection = null; origin.notice = '' }
        else if (origin.diskStatus !== 'changed') origin.diskStatus = 'current'
      } else if (result.status === 'error') origin.error = result.error.message
      else { pendingExternal.set(ref.docId, ref); workspace.changed(); return false }
      workspace.changed()
    }, true)
  }
  async function restoreHistory(target: HistorySnapshot): Promise<boolean> {
    const origin = tab.value
    if (!origin?.session || frozen.value || origin.diskStatus !== 'current' || origin.recoveryPending) return false
    let restored = false
    await runFrozen(origin, async () => { restored = await restoreHistoryAction(workspace, origin, target, request => window.inknest.restoreHistory(request)) })
    return restored
  }
  let retryingHistoryReceipt: Promise<boolean> | null = null
  function retryHistoryRestoreReceipt(): Promise<boolean> {
    if (retryingHistoryReceipt) return retryingHistoryReceipt
    retryingHistoryReceipt = retryHistoryReceipt().finally(() => { retryingHistoryReceipt = null })
    return retryingHistoryReceipt
  }
  async function retryHistoryReceipt(): Promise<boolean> {
    const pending = historyRestorePending.value
    const origin = pending && workspace.getTab(pending.ref)
    if (!origin?.session || workspaceFrozen.value || origin.frozen) return false
    let restored = false
    await runFrozen(origin, async () => { restored = await retryHistoryRestoreAction(workspace, origin, request => window.inknest.restoreHistory(request)) })
    return restored
  }
  async function saveAs(): Promise<void> {
    const origin = tab.value
    if (!origin || !workspace.canSaveAs(origin.document) || frozen.value) return
    await runFrozen(origin, async () => {
      const previous = pendingSaveAs.get(origin)
      const requestId = previous?.requestId ?? crypto.randomUUID(); const snapshot = previous?.snapshot ?? workspace.captureSaveAs(origin.document, requestId)!
      const request: SaveRequest = previous ?? { requestId, snapshot, expectedDiskToken: origin.document.diskToken, trigger: 'manual' }
      pendingSaveAs.set(origin, request)
      const submitting = origin.session ?? origin.copySession!
      origin.saving++; workspace.changed()
      let confirmed = false
      try {
        const result = await window.inknest.saveAs(request)
        if (workspace.getTab(origin.document) !== origin) return
        confirmed = true
        if (result.status === 'ok') {
          if (!workspace.acceptSave(result.value, snapshot.text)) { confirmed = false; throw new Error('Unmatched save receipt') }
          origin.diskStatus = 'current'; origin.inspection = null; origin.error = ''; origin.notice = ''
        }
        else if (result.status === 'error') workspace.failSave(origin.document, requestId, 'failure', result.error.message)
      } catch {
        submitting.holdSave(requestId)
        origin.saveFailure = 'failure'; origin.saveError = copy.saveResultPending
      } finally {
        if (confirmed) { pendingSaveAs.delete(origin); submitting.abandonSave(requestId); workspace.finishSaveAs(origin.document) }
        origin.saving--; workspace.changed()
      }
    })
    if (tab.value === origin && origin.view.mode === 'edit') editor.value?.focus?.()
  }
  async function resolveConflict(action: ConflictAction): Promise<void> {
    if (action === 'save-copy') return saveAs()
    const origin = tab.value
    if (!origin?.session || frozen.value) return
    await runFrozen(origin, async () => {
      const requestId = crypto.randomUUID(); const snapshot = origin.session!.captureSave(requestId)
      try {
        const result = await window.inknest.resolveConflict({ docId: snapshot.docId, epoch: snapshot.epoch }, action, snapshot)
        if (workspace.getTab(origin.document) !== origin) return
        if (result.status === 'ok') {
          if (result.value.kind === 'inspection') origin.inspection = result.value.text
          else if (result.value.kind === 'opened') workspace.replace(origin.document, result.value.document)
          else if (origin.session!.bindSaveReceipt(requestId, result.value.receipt, snapshot.text) && workspace.acceptSave(result.value.receipt, snapshot.text)) { origin.diskStatus = 'current'; origin.inspection = null; origin.error = '' }
        } else if (result.status === 'error') {
          const accepted = workspace.failSave(origin.document, requestId, result.error.code === 'EXTERNAL_CHANGE' ? 'conflict' : 'failure', result.error.message)
          if (accepted && result.error.code === 'EXTERNAL_CHANGE') { origin.diskStatus = 'changed'; origin.inspection = null }
        }
      } finally { origin.session!.abandonSave(requestId); workspace.changed() }
    })
  }
  let systemSelections = Promise.resolve()
  const unsubscribeEvents = window.inknest.onEvent(async event => {
    if (event.type === 'system-document-opened') {
      systemSelections = systemSelections.then(() => install(event.document, null))
      await systemSelections
      return
    }
    if (event.type === 'history-maintenance') { const tab = workspace.getTab(event.ref); if (tab && tab.document.displayPath === event.displayPath && tab.historyMaintenance !== event.failed) { tab.historyMaintenance = event.failed; workspace.changed() }; return }
    if (event.type === 'history-changed') { workspace.acceptHistoryChange(event); return }
    if (event.type === 'recovery-status') { workspace.acceptRecovery(event); return }
    if (event.type === 'menu-command' && (event.command === 'find' || event.command === 'find-next' || event.command === 'find-previous')) { await surface.find?.(event.command); return }
    if (event.type === 'menu-command' && event.command === 'presentation') { await surface.presentation?.(); return }
    if (event.type === 'menu-command' && event.command === 'open') { await openFile(); return }
    if (event.type === 'menu-command' && event.command === 'new') { await createDocument(); return }
    if (event.type === 'menu-command' && event.command === 'backups') { backupsOpen.value = true; return }
    if (event.type === 'menu-command' && event.command === 'close') { if (workspace.active) await closeDocument(workspace.active); return }
    if (event.type === 'menu-command') { if (event.command === 'save-as') { if (!await surface.saveAs?.()) await saveAs() } else if (event.command === 'save') await save(); return }
    if (event.type === 'close-error') { const origin = workspace.getTab(event.ref); if (origin && closeOwners.get(origin) === event.requestId) { origin.error = event.error.message; workspace.changed() }; return }
    if (event.type === 'close-blocked') {
      const origin = workspace.getTab(event.ref)
      if (origin && closeOwners.get(origin) === event.requestId && !workspaceFrozen.value && (same(workspace.active, event.ref) || await settle()) && workspace.getTab(event.ref) === origin && closeOwners.get(origin) === event.requestId && !workspaceFrozen.value) {
        workspace.activate(event.ref)
        if (event.action === 'save-as') {
          if (!origin.document.displayPath) { origin.notice = copy.untitledExit; workspace.changed() }
          else await saveAs()
        }
        drainExternal(origin)
      }
      return
    }
    if (event.type === 'external-change') { await reconcile(event.ref); return }
    if (event.type === 'link-opened') { receiveLinked(event.requestId, event.document); return }
    if (event.type === 'document-created') { await installCreated(event.document); return }
    if (event.type === 'document-opened') {
      // Late duplicates of an open result must not restart a timed-out selection.
      if (!workspace.get(event.document)) await install(event.document, openingSelections)
      return
    }
    if (event.type === 'document-activated') { if (!workspaceFrozen.value && await settle()) workspace.activate(event.ref); return }
    if (event.type === 'document-closed') { const origin = workspace.getTab(event.ref); if (origin) { closeOwners.delete(origin); pendingSaveAs.delete(origin) } if (same(pendingExternal.get(event.ref.docId) ?? null, event.ref)) pendingExternal.delete(event.ref.docId); workspace.remove(event.ref); return }
    if (event.type === 'workspace-freeze') {
      if (freezeId) return
      freezeId = event.requestId; workspaceFrozen.value = true
      for (const ref of workspace.refs) closeOwners.set(workspace.getTab(ref)!, event.requestId)
      // Suspend all timers now, before asynchronous composition/lifecycle preparation.
      workspace.changed()
      freezeReady = (async () => {
        if (lifecycleOperations.size) return false
        if (!await settle() || freezeId !== event.requestId) return false
        for (const ref of workspace.refs) { const state = workspace.getTab(ref)!; state.frozen = true; state.session?.setFrozen(true) }
        editor.value?.setFrozen(true); workspace.changed(); return true
      })()
      return
    }
    if (event.type === 'workspace-thaw') {
      if (freezeId !== event.requestId) return
      freezeId = null; workspaceFrozen.value = false
      for (const ref of workspace.refs) { const state = workspace.getTab(ref)!; state.frozen = lifecycleOperations.has(state); state.session?.setFrozen(state.frozen) }
      editor.value?.setFrozen(tab.value?.session?.frozen ?? tab.value?.frozen ?? false); workspace.changed()
      const refs = [...pendingExternal.values()]; pendingExternal.clear(); for (const ref of refs) void reconcile(ref)
      return
    }
    if (event.type === 'save-receipt') {
      const request = closing.get(event.receipt.requestId)
      if (request?.snapshot) workspace.acceptSave(event.receipt, request.snapshot.text)
      return
    }
    if (event.type === 'close-finished') {
      finishedCloses.add(event.requestId)
      if (finishedCloses.size > 256) finishedCloses.delete(finishedCloses.values().next().value!)
      const request = closing.get(event.requestId)
      if (request) {
        const state = workspace.getTab(request.ref)
        // Normal replies still need their request order; timeout replies are no longer actionable.
        if (event.message) state?.session?.abandonSave(event.requestId)
        if (state && event.message) state.error = event.message
        closing.delete(event.requestId)
        if (state && request.single && !workspaceFrozen.value && !hasClosing(state) && !lifecycleOperations.has(state)) freezeTab(state, false)
      } else if (event.message && tab.value) tab.value.error = event.message
      workspace.changed(); return
    }
    if (event.type !== 'prepare-close' || closing.has(event.requestId) || finishedCloses.has(event.requestId)) return
    const state = workspace.getTab(event.ref)
    if (!state) return
    const token = freezeId
    closeOwners.set(state, token ?? event.requestId)
    const request = { ref: event.ref, snapshot: null as ContentSnapshot | null, single: !token }
    closing.set(event.requestId, request)
    if (request.single) {
      if (lifecycleOperations.has(state)) return
      // Suspend this ref immediately; commit active IME before freezing CodeMirror transactions.
      state.frozen = true; workspace.changed()
      if (same(workspace.active, event.ref) && !await settle()) return
      if (closing.get(event.requestId) !== request || workspace.getTab(event.ref) !== state) return
      freezeTab(state, true)
    } else if (!await freezeReady || freezeId !== token || closing.get(event.requestId) !== request) return
    const snapshot = state.session?.captureSave(event.requestId) ?? null
    request.snapshot = snapshot
    try {
      const result = await window.inknest.completeClose(event.requestId, { ref: event.ref, snapshot })
      if (workspace.getTab(event.ref) !== state) return
      if (result.status === 'error') {
        if (state.session) workspace.failSave(event.ref, event.requestId, result.error.code === 'EXTERNAL_CHANGE' ? 'conflict' : 'failure', result.error.message)
        else if (closeOwners.get(state) === (token ?? event.requestId)) state.error = result.error.message
      }
    } catch {
      if (state.session) workspace.failSave(event.ref, event.requestId, 'failure', copy.closeConfirmationFailed)
      else if (closeOwners.get(state) === (token ?? event.requestId)) state.error = copy.closeConfirmationFailed
    }
    finally { state.session?.abandonSave(event.requestId) }
    workspace.changed()
  })
  onBeforeUnmount(() => { stopAutosave(); recoveryScheduler.dispose(); unsubscribeEvents(); unsubscribe(); workspace.dispose(); closing.clear(); pendingSaveAs.clear(); createdSelections.clear() })
  return { showHome, createDocument, openLinked, historyRestorePending, editingFrozen, retryHistoryRestoreReceipt, restoreHistory, retryRecovery, backupsOpen, signal, workspace, tabs, tab, document, session, dirty, mode, busy, frozen, error, activate, closeDocument, setMode, openFile, save, saveAs, canSaveAs, resolveConflict }
}
