import { afterEach, expect, test, vi } from 'vitest'
import { SaveScheduler } from '../../src/renderer/src/documents/save-scheduler'
const a = { docId: 'a', epoch: 'e1' }; const b = { docId: 'b', epoch: 'e2' }
afterEach(() => vi.useRealTimers())
function setup() { vi.useFakeTimers(); const save = vi.fn(async () => true); return { save, scheduler: new SaveScheduler({ save, idleMs: 1000, maxWaitMs: 10000 }) } }
test('independent files save at 1000ms, continuous input cannot move the first 10000ms deadline', async () => {
  const { save, scheduler } = setup(); scheduler.changed(a); await vi.advanceTimersByTimeAsync(500); scheduler.changed(b)
  await vi.advanceTimersByTimeAsync(499); expect(save).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledWith(a, 'auto')
  await vi.advanceTimersByTimeAsync(500); expect(save).toHaveBeenLastCalledWith(b, 'auto')
  for (let i = 0; i < 20; i++) { scheduler.changed(a); await vi.advanceTimersByTimeAsync(500) }
  expect(save).toHaveBeenCalledTimes(3); scheduler.dispose(a); scheduler.dispose(b)
})
test('composition defers an expired deadline until submission; preview flush saves immediately', async () => {
  const { save, scheduler } = setup(); scheduler.composition(a, true); scheduler.changed(a)
  await vi.advanceTimersByTimeAsync(20000); expect(save).not.toHaveBeenCalled(); scheduler.composition(a, false); await Promise.resolve(); expect(save).toHaveBeenCalledWith(a, 'auto')
  scheduler.changed(a); await scheduler.flush(a, 'mode-change'); expect(save).toHaveBeenLastCalledWith(a, 'mode-change'); expect(vi.getTimerCount()).toBe(0)
})
test('failure pauses even later edits and preview; explicit manual flush resumes, disposal cancels all timers', async () => {
  const { save, scheduler } = setup(); save.mockResolvedValueOnce(false); scheduler.changed(a); await vi.advanceTimersByTimeAsync(1000)
  scheduler.changed(a); await vi.advanceTimersByTimeAsync(20000); await scheduler.flush(a, 'mode-change'); expect(save).toHaveBeenCalledTimes(1)
  await scheduler.flush(a, 'manual'); scheduler.changed(a); await vi.advanceTimersByTimeAsync(1000); expect(save).toHaveBeenCalledTimes(3)
  scheduler.changed(a); scheduler.changed(b); scheduler.dispose(a); scheduler.dispose(b); await vi.advanceTimersByTimeAsync(20000); expect(save).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0)
})
test('one in-flight snapshot retains only latest pending work and manual flush waits for it', async () => {
  const { save, scheduler } = setup(); let release!: (value: boolean) => void
  save.mockImplementationOnce(() => new Promise(resolve => { release = resolve })); scheduler.changed(a); await vi.advanceTimersByTimeAsync(1000)
  for (let i = 0; i < 50; i++) scheduler.changed(a)
  const flush = scheduler.flush(a, 'manual'); await vi.advanceTimersByTimeAsync(20000); expect(save).toHaveBeenCalledTimes(1)
  release(true); await flush; expect(save).toHaveBeenCalledTimes(2); expect(save).toHaveBeenLastCalledWith(a, 'manual'); expect(vi.getTimerCount()).toBe(0)
})
test('late completion after disposal cannot reschedule; resume is an explicit retry action', async () => {
  const { save, scheduler } = setup(); save.mockResolvedValueOnce(false); scheduler.changed(a); await vi.advanceTimersByTimeAsync(1000); scheduler.resume(a); await vi.advanceTimersByTimeAsync(1000); expect(save).toHaveBeenCalledTimes(2)
  let release!: (value: boolean) => void; save.mockImplementationOnce(() => new Promise(resolve => { release = resolve })); scheduler.changed(a); await vi.advanceTimersByTimeAsync(1000); scheduler.changed(a); scheduler.dispose(a); release(true); await vi.advanceTimersByTimeAsync(20000); expect(save).toHaveBeenCalledTimes(3)
})

test('workspace observes only content; recovered preview, selection, receipt and freeze cannot authorize a timer save', async () => {
  const { observeSaveChanges } = await import('../../src/renderer/src/documents/save-scheduler')
  const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const { save, scheduler } = setup(); const workspace = new WorkspaceModel()
  const doc = { ...a, displayName: 'a.md', displayPath: '/a.md', text: 'old', revision: 10, format: { encoding: 'utf-8' as const, bom: false, eol: 'lf' as const }, diskToken: 'token', readOnlyReason: null, recovered: true, readingPosition: null }
  const stop = observeSaveChanges(workspace, scheduler); workspace.install(doc); const tab = workspace.getTab(doc)!; const session = tab.session!
  session.dispatch({ selection: { anchor: 1 } }); await vi.advanceTimersByTimeAsync(20000); expect(save).not.toHaveBeenCalled()
  session.dispatch({ changes: { from: 0, insert: 'edit' } }); await vi.advanceTimersByTimeAsync(500); session.dispatch({ selection: { anchor: 2 } }); workspace.changed(); await vi.advanceTimersByTimeAsync(500); expect(save).toHaveBeenCalledTimes(1)
  session.dispatch({ changes: { from: 0, insert: 'new' } }); tab.frozen = true; workspace.changed(); await vi.advanceTimersByTimeAsync(20000); expect(save).toHaveBeenCalledTimes(1)
  tab.frozen = false; workspace.changed(); await vi.advanceTimersByTimeAsync(1000); expect(save).toHaveBeenCalledTimes(2)
  tab.saveFailure = 'failure'; workspace.changed(); session.dispatch({ changes: { from: 0, insert: 'later' } }); await vi.advanceTimersByTimeAsync(20000); expect(save).toHaveBeenCalledTimes(2)
  workspace.remove(doc); stop(); expect(vi.getTimerCount()).toBe(0)
})

test('undo back to old baseline while A is in flight remains pending after A changes the baseline', async () => {
  const { observeSaveChanges } = await import('../../src/renderer/src/documents/save-scheduler'); const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); const doc = { ...a, displayName: 'a.md', displayPath: '/a.md', text: 'O', revision: 0, format: { encoding: 'utf-8' as const, bom: false, eol: 'lf' as const }, diskToken: 'token', readOnlyReason: null, recovered: false, readingPosition: null }; workspace.install(doc)
  const session = workspace.getSession(doc)!; let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve }); const texts: string[] = []
  const scheduler = new SaveScheduler({ idleMs: 1000, maxWaitMs: 10000, save: async () => {
    if (!session.dirty) return true
    const requestId = String(texts.length); const snapshot = session.captureSave(requestId); texts.push(snapshot.text); if (texts.length === 1) await gate
    return workspace.acceptSave({ requestId, ref: a, savedRevision: snapshot.revision, history: { state: 'unchanged' as const, generation: 0, error: null }, diskToken: 'saved', savedAt: '', displayName: 'a.md', displayPath: '/a.md' }, snapshot.text)
  } }); const stop = observeSaveChanges(workspace, scheduler)
  session.dispatch({ changes: { from: 0, to: 1, insert: 'A' } }); await vi.advanceTimersByTimeAsync(1000)
  session.dispatch({ changes: { from: 0, to: 1, insert: 'O' } }); expect(session.dirty).toBe(false); await vi.advanceTimersByTimeAsync(1000)
  finish(); await vi.advanceTimersByTimeAsync(2000); expect(texts).toEqual(['A', 'O']); expect(session.dirty).toBe(false); stop()
})

test('freeze and thaw do not start a second auto while the accepted response is still held', async () => {
  const { observeSaveChanges } = await import('../../src/renderer/src/documents/save-scheduler'); const { WorkspaceModel } = await import('../../src/renderer/src/documents/workspace')
  const { save, scheduler } = setup(); let release!: (ok: boolean) => void; save.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const workspace = new WorkspaceModel(); const doc = { ...a, displayName: 'a.md', displayPath: '/a.md', text: 'old', revision: 0, format: { encoding: 'utf-8' as const, bom: false, eol: 'lf' as const }, diskToken: 'token', readOnlyReason: null, recovered: false, readingPosition: null }; workspace.install(doc)
  const stop = observeSaveChanges(workspace, scheduler); const tab = workspace.getTab(doc)!; tab.session!.dispatch({ changes: { from: 0, insert: 'A' } }); await vi.advanceTimersByTimeAsync(1000)
  tab.frozen = true; workspace.changed(); tab.frozen = false; workspace.changed(); tab.session!.dispatch({ changes: { from: 0, insert: 'B' } }); await vi.advanceTimersByTimeAsync(2000)
  expect(save).toHaveBeenCalledTimes(1); release(true); await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledTimes(2); stop()
})

test('concurrent explicit manual actions retain independent outcomes while timers wait for both', async () => {
  const { save, scheduler } = setup(); let release!: (ok: boolean) => void; save.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const first = scheduler.flush(a, 'manual'); await Promise.resolve(); const second = scheduler.flush(a, 'manual'); await Promise.resolve(); await Promise.resolve()
  expect(save).toHaveBeenCalledTimes(2); expect(await second).toBe(true)
  scheduler.changed(a); await vi.advanceTimersByTimeAsync(2000); expect(save).toHaveBeenCalledTimes(2)
  release(true); await first; await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledTimes(3); scheduler.dispose(a)
})
