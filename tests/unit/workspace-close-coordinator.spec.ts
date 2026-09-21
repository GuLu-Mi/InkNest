import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { CloseCoordinator, type CloseChoice } from '../../src/main/documents/close-coordinator'
import { WorkspaceCloseCoordinator } from '../../src/main/documents/workspace-close-coordinator'
import { RecoveryStore } from '../../src/main/documents/recovery-store'
import { atomicWrite, type AtomicWriter } from '../../src/main/documents/atomic-writer'
import type { AppEvent, ContentSnapshot, CurrentState } from '../../src/shared/contracts'
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(failB = false) {
  const root = await mkdtemp(join(tmpdir(), 'inknest-window-unit-')); roots.push(root)
  const registry = new DocumentRegistry(); const aPath = join(root, 'a.md'); const bPath = join(root, 'b.md')
  await writeFile(aPath, 'A'); await writeFile(bPath, 'B'); await registry.open(aPath, 1); const a = registry.current!; await registry.open(bPath, 1); const b = registry.current!
  const writer: AtomicWriter = async (path, bytes, options) => { if (failB && path.endsWith('/b.md')) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return atomicWrite(path, bytes, options) }
  let manifestHook: (() => Promise<void>) | undefined; let respond = true; let failManifest = false; let choice: CloseChoice = 'cancel'; let confirmed = false; let confirmDiscard = async () => confirmed
  const recovery = new RecoveryStore(join(root, 'recovery'), registry, { beforeManifest: async () => { if (failManifest) throw new Error('manifest failure'); await manifestHook?.() } }); const saves = new SaveCoordinator(registry, writer, { recovery }); const events: AppEvent[] = []
  const snapshots = new Map<string, ContentSnapshot | null>([a, b].map(session => [session.document.docId, { docId: session.document.docId, epoch: session.document.epoch, text: `${session === a ? 'A' : 'B'} complete latest`, revision: 1 }]))
  const send = (event: AppEvent) => { events.push(event); if (respond && event.type === 'prepare-close') { void workspace.complete(event.requestId, { ref: event.ref, snapshot: snapshots.get(event.ref.docId)! }) } }
  const close = new CloseCoordinator(registry, send, async () => choice, saves, recovery, () => confirmDiscard())
  const workspace = new WorkspaceCloseCoordinator(registry, 1, send, close, saves, recovery)
  return { beforeManifest: (operation: () => Promise<void>) => { manifestHook = operation }, confirmWith: (operation: () => Promise<boolean>) => { confirmDiscard = operation }, respond: (value: boolean) => { respond = value }, snapshots, choose: (value: CloseChoice, confirm = false) => { choice = value; confirmed = confirm }, manifestFailure: (value: boolean) => { failManifest = value }, root, registry, a, b, aPath, bPath, recovery, saves, events, workspace, send, state: (text: string): CurrentState => ({ ref: a.document, snapshot: { ...a.document, revision: 1, text } }) }
}
test('closing background A saves and releases only A while B remains unchanged and active', async () => {
  const f = await fixture(); f.a.resources.set('old-image', { path: 'unused', dev: 1, ino: 2 })
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'ok' })
  expect(await readFile(f.aPath, 'utf8')).toBe('A complete latest'); expect(await readFile(f.bPath, 'utf8')).toBe('B')
  expect(f.registry.list(1)).toEqual([f.b]); expect(f.registry.current).toBe(f.b); expect(f.a.resources.size).toBe(0)
  expect(f.events.filter(event => event.type === 'workspace-freeze')).toHaveLength(0)
})
test('window A success then B failure preserves all refs and complete texts without rolling back A', async () => {
  const f = await fixture(true)
  expect(await f.workspace.closeWindow()).toBe(false)
  expect(f.events.filter(event => event.type === 'prepare-close')).toHaveLength(2)
  expect(f.registry.list(1)).toEqual([f.a, f.b]); expect(f.a.latestSnapshot?.text).toBe('A complete latest'); expect(f.b.latestSnapshot?.text).toBe('B complete latest')
  expect(await readFile(f.aPath, 'utf8')).toBe('A complete latest'); expect(await readFile(f.bPath, 'utf8')).toBe('B')
  expect(f.events.filter(event => event.type === 'document-closed')).toHaveLength(0)
  expect(f.events.some(event => event.type === 'workspace-thaw')).toBe(true)
})
test('window success releases all only after every latest text was saved', async () => {
  const f = await fixture()
  expect(await f.workspace.closeWindow()).toBe(true)
  expect(f.registry.list(1)).toHaveLength(0); expect(await readFile(f.aPath, 'utf8')).toBe('A complete latest'); expect(await readFile(f.bPath, 'utf8')).toBe('B complete latest')
  expect(f.events.filter(event => event.type === 'document-closed')).toHaveLength(2)
})

test('cleanup failure preserves all tabs and a maintained A can create its next recovery snapshot', async () => {
  const f = await fixture()
  await f.recovery.checkpoint(f.a, { ...f.a.document, revision: 1, text: 'A complete latest' })
  const original = f.recovery.afterSave.bind(f.recovery)
  f.recovery.afterSave = async (session, revision) => { if (session === f.b) throw new Error('cleanup failure'); return original(session, revision) }
  expect(await f.workspace.closeWindow()).toBe(false); expect(f.registry.list(1)).toHaveLength(2)
  await f.recovery.list() // Owner maintenance must retain A although its manifest is now empty.
  expect((Reflect.get(f.recovery, 'owners') as Map<string, WeakRef<unknown>>).size).toBe(1)
  await expect(f.recovery.checkpoint(f.a, { ...f.a.document, revision: 2, text: 'A next complete draft' })).resolves.toMatchObject({ revision: 2 })
  const entries = await f.recovery.list(); expect(entries).toHaveLength(1); expect(await f.recovery.inspect(entries[0]!.id)).toBe('A next complete draft')
})

test('explicit discard failure preserves owned recovery and text; success durably marks before releasing', async () => {
  const f = await fixture(); const snapshot = f.snapshots.get(f.a.document.docId)!
  await f.recovery.checkpoint(f.a, snapshot!); const id = (await f.recovery.list())[0]!.id
  f.a.diskStatus = 'changed'; f.choose('discard', true); f.manifestFailure(true)
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'error' }); expect(f.registry.has(f.a)).toBe(true)
  expect(await f.recovery.inspect(id)).toBe('A complete latest'); expect(await readFile(f.aPath, 'utf8')).toBe('A')
  f.manifestFailure(false)
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'ok' }); expect(f.registry.has(f.a)).toBe(false)
  expect(JSON.parse(await readFile(join(f.root, 'recovery', id, 'discarded.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, sessionId: id })
  expect(await new RecoveryStore(join(f.root, 'recovery'), f.registry).list()).toEqual([])
  await expect(f.recovery.checkpoint(f.a, snapshot!)).rejects.toThrow(); expect(await readFile(f.aPath, 'utf8')).toBe('A')
})
test('edit/checkpoint/undo-to-baseline clean close retires only its associated stale recovery', async () => {
  const f = await fixture(); await f.recovery.checkpoint(f.a, f.snapshots.get(f.a.document.docId)!)
  f.snapshots.set(f.a.document.docId, { ...f.a.document, revision: 2, text: 'A' })
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'ok' })
  expect(await new RecoveryStore(join(f.root, 'recovery'), f.registry).list()).toEqual([]); expect(await readFile(f.aPath, 'utf8')).toBe('A')
})
test('closing an unassociated same-path session leaves the pending original recovery intact', async () => {
  const f = await fixture(); await f.recovery.checkpoint(f.a, f.snapshots.get(f.a.document.docId)!)
  const id = (await f.recovery.list())[0]!.id
  f.registry.release(f.a.document, 1); await f.registry.open(f.aPath, 1); const reopened = f.registry.current!
  f.snapshots.set(reopened.document.docId, { ...reopened.document, revision: 0, text: 'A' })
  expect(await f.workspace.closeDocument(reopened.document)).toMatchObject({ status: 'ok' })
  expect(await f.recovery.inspect(id)).toBe('A complete latest'); expect(await f.recovery.list()).toHaveLength(1)
})
test('readonly missing identity-only document can explicitly close without writing its protected source', async () => {
  const f = await fixture(); f.a.document.readOnlyReason = 'size'; f.a.diskStatus = 'missing'; f.snapshots.set(f.a.document.docId, null)
  expect(await f.workspace.closeWindow()).toBe(false); expect(f.registry.has(f.a)).toBe(true)
  f.choose('discard', true)
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'ok' }); expect(await readFile(f.aPath, 'utf8')).toBe('A')
})
test('readonly recovery pending cannot be cleaned by a null snapshot; only confirmed owned discard releases it', async () => {
  const f = await fixture(); await f.recovery.checkpoint(f.a, f.snapshots.get(f.a.document.docId)!)
  const id = (await f.recovery.list())[0]!.id
  // Defensive boundary: registerRecovery currently always creates editable sessions.
  f.a.document.readOnlyReason = 'link'; f.a.recoveryPending = true; f.snapshots.set(f.a.document.docId, null)
  expect(await f.workspace.closeWindow()).toBe(false); expect(await f.recovery.inspect(id)).toBe('A complete latest')
  f.choose('discard', true)
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'ok' }); expect(f.registry.has(f.a)).toBe(false)
})
test('pending restore/open admission cancels a window barrier before a late session can be registered', async () => {
  const f = await fixture(); let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const path = join(f.root, 'late.md'); await writeFile(path, 'late complete')
  const operation = f.workspace.admission(async () => { await wait; return f.registry.open(path, 1) })
  expect(await f.workspace.closeWindow()).toBe(false); expect(f.registry.list(1)).toHaveLength(2); expect(f.events.filter(event => event.type === 'prepare-close')).toEqual([])
  release(); expect(await operation).toMatchObject({ status: 'ok' }); expect(f.registry.list(1)).toHaveLength(3)
})

test('whole-window unanswered challenge times out, thaws the same id, and rejects the old reply', async () => {
  const f = await fixture(); f.respond(false); vi.useFakeTimers()
  const closing = f.workspace.closeWindow(); const event = f.events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing challenge')
  expect(await f.workspace.closeDocument(f.a.document)).toMatchObject({ status: 'cancelled' })
  await vi.advanceTimersByTimeAsync(5000); expect(await closing).toBe(false)
  expect(await f.workspace.complete(event.requestId, { ref: event.ref, snapshot: f.snapshots.get(event.ref.docId)! })).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  const freeze = f.events.find(event => event.type === 'workspace-freeze')!
  expect(f.events).toContainEqual({ type: 'workspace-thaw', requestId: 'requestId' in freeze ? freeze.requestId : '' }); expect(f.registry.list(1)).toHaveLength(2)
})
test('membership changes during an already-started challenge cancel all releases', async () => {
  const f = await fixture(); f.respond(false)
  const closing = f.workspace.closeWindow(); const first = f.events.find(event => event.type === 'prepare-close')!
  if (first.type !== 'prepare-close') throw new Error('missing challenge')
  const path = join(f.root, 'late.md'); await writeFile(path, 'late complete'); await f.registry.open(path, 1)
  f.respond(true); await f.workspace.complete(first.requestId, { ref: first.ref, snapshot: f.snapshots.get(first.ref.docId)! })
  expect(await closing).toBe(false); expect(f.registry.list(1)).toHaveLength(3); expect(f.events.filter(event => event.type === 'document-closed')).toHaveLength(0)
})
test('a newer checkpoint arriving after close confirmation cancels release without clearing that newer draft', async () => {
  const f = await fixture(); const original = f.recovery.afterSave.bind(f.recovery); let aMaintenance = 0
  f.recovery.afterSave = async (session, revision) => {
    await original(session, revision)
    if (session === f.a && revision === 1 && ++aMaintenance === 2) { await f.recovery.checkpoint(session, { docId: session.document.docId, epoch: session.document.epoch, revision: 2, text: 'newer complete draft' }) }
  }
  expect(await f.workspace.closeWindow()).toBe(false); expect(f.registry.list(1)).toHaveLength(2)
  const id = (await f.recovery.list())[0]!.id; expect(await f.recovery.inspect(id)).toBe('newer complete draft')
  expect(f.events.at(-1)).toMatchObject({ type: 'close-blocked', ref: { docId: f.a.document.docId, epoch: f.a.document.epoch } })
})

test('newer checkpoint while discard confirmation waits cancels discard before publishing a permanent marker', async () => {
  const f = await fixture(); await f.recovery.checkpoint(f.a, f.snapshots.get(f.a.document.docId)!)
  f.a.diskStatus = 'changed'; f.choose('discard', true); let answer!: (value: boolean) => void; let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }); f.confirmWith(() => new Promise(resolve => { answer = resolve; entered() }))
  const closing = f.workspace.closeDocument(f.a.document); await ready
  await f.recovery.checkpoint(f.a, { docId: f.a.document.docId, epoch: f.a.document.epoch, revision: 2, text: 'newer undiscarded complete' })
  answer(true); expect(await closing).toMatchObject({ status: 'error' }); expect(f.registry.has(f.a)).toBe(true)
  const id = (await f.recovery.list())[0]!.id; expect(await f.recovery.inspect(id)).toBe('newer undiscarded complete')
  await expect(readFile(join(f.root, 'recovery', id, 'discarded.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('discard revalidates inside the recovery queue after a previously queued newer checkpoint', async () => {
  const f = await fixture(); await f.recovery.checkpoint(f.a, f.snapshots.get(f.a.document.docId)!)
  let release!: () => void; let entered!: () => void; let once = false
  const blocked = new Promise<void>(resolve => { entered = resolve }); const gate = new Promise<void>(resolve => { release = resolve })
  f.beforeManifest(async () => { if (!once) { once = true; entered(); await gate } })
  const backingB = f.recovery.checkpoint(f.b, f.snapshots.get(f.b.document.docId)!); await blocked
  const newer = f.recovery.checkpoint(f.a, { docId: f.a.document.docId, epoch: f.a.document.epoch, revision: 2, text: 'queued newer complete draft' })
  f.a.diskStatus = 'changed'; f.choose('discard', true)
  let confirming!: () => void; const ready = new Promise<void>(resolve => { confirming = resolve }); f.confirmWith(async () => { confirming(); return true })
  const closing = f.workspace.closeDocument(f.a.document); await ready; await Promise.resolve(); release(); await backingB; await newer
  expect(await closing).toMatchObject({ status: 'error' }); expect(f.registry.has(f.a)).toBe(true)
  const entries = await f.recovery.list(); const aEntry = entries.find(entry => entry.displayName === 'a.md')!; expect(await f.recovery.inspect(aEntry.id)).toBe('queued newer complete draft')
})

test('a late rejected checkpoint after durable discard cannot change the main latest snapshot', async () => {
  const f = await fixture(); const snapshot = f.snapshots.get(f.a.document.docId)!
  await f.recovery.checkpoint(f.a, snapshot!); await f.recovery.discardSession(f.a)
  await expect(f.recovery.checkpoint(f.a, { docId: f.a.document.docId, epoch: f.a.document.epoch, revision: 2, text: 'rejected late text' })).rejects.toThrow()
  expect(f.a.latestSnapshot).toEqual(snapshot)
})
