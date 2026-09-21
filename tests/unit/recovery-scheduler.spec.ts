import { afterEach, expect, test, vi } from 'vitest'
import { RecoveryScheduler } from '../../src/renderer/src/documents/recovery-scheduler'
import { WorkspaceModel } from '../../src/renderer/src/documents/workspace'
import type { OpenDocument } from '../../src/shared/contracts'
const document: OpenDocument = { docId: 'a', epoch: 'e', displayName: 'a.md', displayPath: '/a.md', text: 'old', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'token', readOnlyReason: null, recovered: false, readingPosition: null }
afterEach(() => vi.useRealTimers())
test('independent 2000/10000 checkpoint timer ignores selection and readonly, background runs once per changed revision', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document }); const checkpoint = vi.fn(async snapshot => ({ status: 'ok' as const, value: { revision: snapshot.revision, savedAt: new Date().toISOString() } }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint)
  const session = workspace.getSession(document)!
  session.dispatch({ changes: { from: 3, insert: '1' } }); await vi.advanceTimersByTimeAsync(1999); expect(checkpoint).not.toHaveBeenCalled()
  session.dispatch({ selection: { anchor: 1 } }); await vi.advanceTimersByTimeAsync(1); expect(checkpoint).toHaveBeenCalledTimes(1)
  expect(workspace.getTab(document)!.recoveryStatus).toBe('backed-up')
  for (let i = 0; i < 10; i++) { session.dispatch({ changes: { from: 0, insert: 'x' } }); await vi.advanceTimersByTimeAsync(1000) }
  expect(checkpoint).toHaveBeenCalledTimes(2)
  workspace.install({ ...document, docId: 'readonly', readOnlyReason: 'size' }); await vi.advanceTimersByTimeAsync(20000); expect(checkpoint).toHaveBeenCalledTimes(2)
  scheduler.dispose()
})
test('failed current checkpoint cannot claim older backup, and does not clear formal save error', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document }); const checkpoint = vi.fn(async () => ({ status: 'error' as const, error: { code: 'RECOVERY_FAILED' as const, message: 'backup failed', retryable: true } }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint); const tab = workspace.getTab(document)!; tab.saveError = 'save conflict'
  tab.session!.dispatch({ changes: { from: 0, insert: 'new' } }); await vi.advanceTimersByTimeAsync(2000)
  expect(tab.recoveryStatus).toBe('error'); expect(tab.saveError).toBe('save conflict')
  await vi.advanceTimersByTimeAsync(20000); expect(checkpoint).toHaveBeenCalledTimes(1)
  scheduler.dispose()
})
test('recovered preview does not resend text, pending gate clears only after a real edit and stale result cannot mark new text backed up', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); const recovered = { ...document, recovered: true, revision: 10 }; workspace.install(recovered)
  let finish!: (value: { status: 'ok'; value: { revision: number; savedAt: string } }) => void
  const checkpoint = vi.fn(() => new Promise<{ status: 'ok'; value: { revision: number; savedAt: string } }>(resolve => { finish = resolve }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint); const tab = workspace.getTab(recovered)!
  await vi.advanceTimersByTimeAsync(20000); expect(checkpoint).not.toHaveBeenCalled(); expect(tab.recoveryPending).toBe(true)
  tab.session!.dispatch({ selection: { anchor: 1 } }); expect(tab.recoveryPending).toBe(true)
  tab.session!.dispatch({ changes: { from: 0, insert: 'edit' } }); expect(tab.recoveryPending).toBe(false)
  await vi.advanceTimersByTimeAsync(2000); tab.session!.dispatch({ changes: { from: 0, insert: 'later' } })
  finish({ status: 'ok', value: { revision: 11, savedAt: new Date().toISOString() } }); await Promise.resolve(); expect(tab.recoveryStatus).toBe('pending')
  scheduler.dispose()
})
test('checkpoint waits for composition submission and captures latest committed text', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document })
  let commit!: (ready: boolean) => void; const ready = new Promise<boolean>(resolve => { commit = resolve })
  const checkpoint = vi.fn(async snapshot => ({ status: 'ok' as const, value: { revision: snapshot.revision, savedAt: new Date().toISOString() } }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint, async () => ready)
  const session = workspace.getSession(document)!; session.dispatch({ changes: { from: 0, insert: '候选' } })
  await vi.advanceTimersByTimeAsync(10000); expect(checkpoint).not.toHaveBeenCalled()
  session.dispatch({ changes: { from: 0, to: 2, insert: '提交' } }); commit(true); await Promise.resolve(); await Promise.resolve()
  expect(checkpoint).toHaveBeenCalledTimes(1); expect(checkpoint.mock.calls[0]![0].text).toBe('提交old')
  scheduler.dispose()
})

test('explicit recovery retry uses the failed revision once, preserves save/conflict state and never saves the original', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document })
  const checkpoint = vi.fn().mockResolvedValueOnce({ status: 'error', error: { code: 'RECOVERY_FAILED', message: 'backup failed', retryable: true } }).mockResolvedValue({ status: 'ok', value: { revision: 1, savedAt: 'now' } })
  const scheduler = new RecoveryScheduler(workspace, checkpoint); const tab = workspace.getTab(document)!
  tab.session!.dispatch({ changes: { from: 0, insert: 'latest ' } }); await vi.advanceTimersByTimeAsync(2000)
  tab.saveError = 'save conflict'; tab.diskStatus = 'changed'; tab.recoveryPending = true
  expect(tab.recoveryStatus).toBe('error')
  await scheduler.retry(document)
  expect(checkpoint).toHaveBeenCalledTimes(2); expect(checkpoint.mock.calls[1]![0].text).toBe('latest old')
  expect(tab.recoveryStatus).toBe('backed-up'); expect(tab.recoveryError).toBe(''); expect(tab.saveError).toBe('save conflict'); expect(tab.diskStatus).toBe('changed'); expect(tab.recoveryPending).toBe(true)
  expect(tab.session!.dirty).toBe(true); expect(tab.document.text).toBe('old'); scheduler.dispose()
})

test('retry is bounded while running and keeps newer revisions pending without accepting an old result', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document })
  let finish!: (result: { status: 'ok'; value: { revision: number; savedAt: string } }) => void
  const checkpoint = vi.fn(() => new Promise<{ status: 'ok'; value: { revision: number; savedAt: string } }>(resolve => { finish = resolve }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint); const tab = workspace.getTab(document)!
  tab.session!.dispatch({ changes: { from: 0, insert: 'one ' } })
  const first = scheduler.retry(document); await Promise.resolve(); await scheduler.retry(document)
  expect(checkpoint).toHaveBeenCalledTimes(1)
  tab.session!.dispatch({ changes: { from: 0, insert: 'two ' } }); finish({ status: 'ok', value: { revision: 1, savedAt: 'now' } }); await first
  expect(tab.recoveryStatus).toBe('pending'); await vi.advanceTimersByTimeAsync(2000)
  expect(checkpoint).toHaveBeenCalledTimes(2); expect(checkpoint.mock.calls[1]![0].text).toBe('two one old')
  finish({ status: 'ok', value: { revision: 2, savedAt: 'now' } }); await Promise.resolve(); scheduler.dispose()
})

test('explicit retry refuses stale refs, frozen state and a freeze arriving during composition', async () => {
  vi.useFakeTimers(); const workspace = new WorkspaceModel(); workspace.install({ ...document })
  let ready!: (value: boolean) => void
  const checkpoint = vi.fn(async snapshot => ({ status: 'ok' as const, value: { revision: snapshot.revision, savedAt: 'now' } }))
  const scheduler = new RecoveryScheduler(workspace, checkpoint, () => new Promise(resolve => { ready = resolve }))
  const tab = workspace.getTab(document)!; tab.session!.dispatch({ changes: { from: 0, insert: 'new ' } })
  await scheduler.retry({ ...document, epoch: 'old' }); tab.frozen = true; await scheduler.retry(document); tab.frozen = false
  let permitted = true; const retry = scheduler.retry(document, () => permitted); permitted = false; ready(true); await retry
  expect(checkpoint).not.toHaveBeenCalled(); expect(tab.session!.dirty).toBe(true); scheduler.dispose()
})
