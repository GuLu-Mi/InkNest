import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { atomicWrite, type AtomicWriter } from '../../src/main/documents/atomic-writer'
import { FileLifecycle } from '../../src/main/documents/file-lifecycle'
import { DirectoryWatcher } from '../../src/main/documents/watcher'
import { CloseCoordinator } from '../../src/main/documents/close-coordinator'
import type { AppEvent, CurrentState, SaveRequest } from '../../src/shared/contracts'
let root: string
const disposers: (() => void)[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-lifecycle-'))) })
afterEach(async () => { disposers.splice(0).forEach(fn => fn()); await rm(root, { recursive: true, force: true }) })
async function setup(writer: AtomicWriter = atomicWrite) {
  const path = join(root, 'a.md'); await writeFile(path, 'disk1')
  const registry = new DocumentRegistry(); await registry.open(path, 1)
  const a = registry.current!; const ref = { docId: a.document.docId, epoch: a.document.epoch }
  const saves = new SaveCoordinator(registry, writer)
  let target: string | null = null
  let confirm: () => Promise<boolean> = async () => true
  const lifecycle = new FileLifecycle(registry, saves, { choosePath: async () => target, confirm: async () => confirm() })
  const state = (text = 'disk1', revision = 0): CurrentState => ({ ref, snapshot: { ...ref, text, revision } })
  const request = (text = 'local2', revision = 1): SaveRequest => ({ requestId: randomUUID(), snapshot: state(text, revision).snapshot!, expectedDiskToken: a.document.diskToken, trigger: 'manual' })
  return { registry, saves, lifecycle, a, ref, path, state, request, target: (path: string | null) => { target = path }, confirm: (fn: () => Promise<boolean>) => { confirm = fn } }
}

test('clean atomic external replacement installs new epoch and revokes old resources without activating background A', async () => {
  const f = await setup(); f.a.resources.set('old', { path: f.path, dev: 1, ino: 1 })
  const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1); const b = f.registry.current
  const replacement = join(root, 'replacement.md'); await writeFile(replacement, 'disk2'); await rename(replacement, f.path)
  const result = await f.lifecycle.reconcileExternal(f.state(), 1)
  expect(result).toMatchObject({ status: 'ok', value: { kind: 'reloaded', document: { docId: f.ref.docId, text: 'disk2' } } })
  if (result.status === 'ok' && result.value.kind === 'reloaded') expect(result.value.document.epoch).not.toBe(f.ref.epoch)
  expect(f.registry.get(f.ref, 1)).toBeUndefined(); expect(f.a.resources.size).toBe(0); expect(f.registry.current).toBe(b)
})

test('fresh dirty snapshot on background A keeps local2 and disk2 while B is untouched', async () => {
  const f = await setup(); const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1); const b = f.registry.current
  await writeFile(f.path, 'disk2')
  expect(await f.lifecycle.reconcileExternal(f.state('local2', 1), 1)).toEqual({ status: 'ok', value: { kind: 'conflict', diskStatus: 'changed' } })
  expect(f.a.latestSnapshot?.text).toBe('local2'); expect(await readFile(f.path, 'utf8')).toBe('disk2'); expect(f.registry.current).toBe(b); expect(b!.document.text).toBe('B')
  expect(await f.lifecycle.resolveConflict(f.ref, 'inspect', f.state('local2', 1).snapshot!, 1)).toMatchObject({ status: 'ok', value: { kind: 'inspection', text: 'disk2' } })
})

test('same-byte mtime updates keep epoch, deletion and permission failure preserve memory with distinct status', async () => {
  const f = await setup(); const before = await stat(f.path); await utimes(f.path, before.atime, new Date(before.mtimeMs + 5000))
  expect(await f.lifecycle.reconcileExternal(f.state(), 1)).toEqual({ status: 'ok', value: { kind: 'unchanged' } }); expect(f.a.document.epoch).toBe(f.ref.epoch)
  await chmod(f.path, 0)
  expect(await f.lifecycle.reconcileExternal(f.state(), 1)).toEqual({ status: 'ok', value: { kind: 'conflict', diskStatus: 'unavailable' } })
  await chmod(f.path, 0o600); await rm(f.path)
  expect(await f.lifecycle.reconcileExternal(f.state(), 1)).toEqual({ status: 'ok', value: { kind: 'conflict', diskStatus: 'missing' } }); expect(f.a.document.text).toBe('disk1')
})

test('readable permission-readonly source stays current on focus checks, reconciliation and normal close', async () => {
  const path = join(root, 'readonly.md'); await writeFile(path, 'readonly content'); await chmod(path, 0o444)
  const registry = new DocumentRegistry(); await registry.open(path, 1); const session = registry.current!
  const ref = { docId: session.document.docId, epoch: session.document.epoch }; const state = { ref, snapshot: null }
  expect(session.document.readOnlyReason).toBe('permission')
  const saves = new SaveCoordinator(registry); const lifecycle = new FileLifecycle(registry, saves, { choosePath: async () => null, confirm: async () => false })
  const signals: AppEvent[] = []; const watcher = new DirectoryWatcher(registry, event => signals.push(event)); disposers.push(() => watcher.dispose())
  watcher.sync(1); await watcher.check(session)
  expect(signals).toEqual([])
  expect(await lifecycle.reconcileExternal(state, 1)).toEqual({ status: 'ok', value: { kind: 'unchanged' } })
  expect(session.diskStatus).toBe('current'); expect(session.document.text).toBe('readonly content'); expect(session.document.epoch).toBe(ref.epoch)
  const events: AppEvent[] = []; const close = new CloseCoordinator(registry, event => events.push(event), async () => { throw new Error('clean readonly must not prompt') }, saves)
  const preparing = close.prepare(); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing close request')
  expect(await close.complete(event.requestId, state)).toMatchObject({ status: 'ok' }); expect(await preparing).toBe(true); close.finish()
  expect(await readFile(path, 'utf8')).toBe('readonly content')
})

test('losing write permission in an editable session remains unavailable despite readable bytes', async () => {
  const f = await setup(); await chmod(f.path, 0o444)
  const signals: AppEvent[] = []; const watcher = new DirectoryWatcher(f.registry, event => signals.push(event)); disposers.push(() => watcher.dispose())
  await watcher.check(f.a)
  expect(signals).toMatchObject([{ type: 'external-change', diskStatus: 'unavailable' }])
  expect(await f.lifecycle.reconcileExternal(f.state(), 1)).toEqual({ status: 'ok', value: { kind: 'conflict', diskStatus: 'unavailable' } })
  expect(await readFile(f.path, 'utf8')).toBe('disk1')
})

test('SaveAs cancellation and opened target aliases never change either document or bytes', async () => {
  const f = await setup(); expect(await f.lifecycle.saveAs(f.request(), 1)).toEqual({ status: 'cancelled' })
  const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1)
  const alias = join(root, 'alias.md'); await link(bPath, alias)
  for (const path of [bPath, alias]) { f.target(path); expect(await f.lifecycle.saveAs(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'TARGET_OPEN' } }) }
  expect(f.a.path).toBe(f.path); expect(await readFile(f.path, 'utf8')).toBe('disk1'); expect(await readFile(bPath, 'utf8')).toBe('B'); expect(f.registry.list(1)).toHaveLength(2)
})

test('SaveAs writer failure retains old path, baseline and latest editable text', async () => {
  const f = await setup(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }); const target = join(root, 'copy.md'); f.target(target)
  expect(await f.lifecycle.saveAs(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'ACCESS_DENIED' } })
  expect(f.a.path).toBe(f.path); expect(f.a.document.text).toBe('disk1'); expect(f.a.latestSnapshot?.text).toBe('local2'); expect(await readFile(f.path, 'utf8')).toBe('disk1'); await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('SaveAs publishes verified bytes/path/resources with continuous identity, and duplicate request never reprompts', async () => {
  const f = await setup(); await mkdir(join(root, 'next')); const target = join(root, 'next', 'copy.md'); f.target(target)
  f.a.resources.set('old', { path: f.path, dev: 1, ino: 1 }); f.a.resourceBytes = 123; const request = f.request()
  const result = await f.lifecycle.saveAs(request, 1)
  expect(result).toMatchObject({ status: 'ok', value: { ref: f.ref, savedRevision: 1, displayPath: target } })
  expect(f.a.path).toBe(target); expect(f.a.root).toBe(join(root, 'next')); expect(f.a.resources.size).toBe(0); expect(f.a.resourceBytes).toBe(123)
  expect(await readFile(target, 'utf8')).toBe('local2'); expect(await readFile(f.path, 'utf8')).toBe('disk1')
  f.target(null); expect(await f.lifecycle.saveAs(request, 1)).toEqual(result)
  expect((await f.saves.save(f.request('local3', 2), 1)).status).toBe('ok'); expect(await readFile(target, 'utf8')).toBe('local3')
})

test('overwrite binds displayed disk2 token; confirmation racing disk3 cannot overwrite disk3', async () => {
  const f = await setup(); await writeFile(f.path, 'disk2'); await f.lifecycle.reconcileExternal(f.state('local2', 1), 1)
  f.confirm(async () => { await writeFile(f.path, 'disk3'); return true })
  expect(await f.lifecycle.resolveConflict(f.ref, 'overwrite', f.state('local2', 1).snapshot!, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('disk3'); expect(f.a.latestSnapshot?.text).toBe('local2')
})

test('use disk cancels queued old writes, drains active write and rejects stale epoch calls', async () => {
  const f = await setup(); await writeFile(f.path, 'disk2'); await f.lifecycle.reconcileExternal(f.state('local2', 1), 1)
  const result = await f.lifecycle.resolveConflict(f.ref, 'use-disk', f.state('local2', 1).snapshot!, 1)
  expect(result).toMatchObject({ status: 'ok', value: { kind: 'opened', document: { text: 'disk2' } } })
  expect(await f.saves.save(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
})

test('known conflict cannot close silently even when older save success made latest text match baseline', async () => {
  const f = await setup(); const request = f.request(); expect((await f.saves.save(request, 1)).status).toBe('ok')
  await writeFile(f.path, 'disk2'); expect((await f.saves.save(f.request(), 1)).status).toBe('error')
  const events: AppEvent[] = []; const close = new CloseCoordinator(f.registry, event => events.push(event), async () => 'cancel', f.saves)
  const preparing = close.prepare(); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing close request')
  expect((await close.complete(event.requestId, f.state('local2', 1))).status).toBe('error'); expect(await preparing).toBe(false); close.finish()
  expect(await readFile(f.path, 'utf8')).toBe('disk2')
})

test('shared parent watch survives atomic replacement and stops signalling released references', async () => {
  const f = await setup(); const bPath = join(root, 'b.md'); await writeFile(bPath, 'B'); await f.registry.open(bPath, 1)
  const signals: AppEvent[] = []; const watcher = new DirectoryWatcher(f.registry, event => signals.push(event)); disposers.push(() => watcher.dispose()); watcher.sync(1)
  const watches = Reflect.get(watcher, 'directories') as Map<string, { watcher: import('node:fs').FSWatcher }>
  expect(watches.size).toBe(1)
  const watchErrors: string[] = []; for (const entry of watches.values()) entry.watcher.on('error', error => watchErrors.push((error as NodeJS.ErrnoException).code ?? error.message))
  const observedAt = performance.now()
  const replacement = join(root, 'replace.md'); await writeFile(replacement, 'disk2'); await rename(replacement, f.path)
  await expect.poll(() => signals.filter(event => event.type === 'external-change' && event.ref.docId === f.ref.docId).length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(watches.size, `watch errors: ${watchErrors.join(', ')}`).toBe(1)
  const replacementMs = performance.now() - observedAt; const releasedAt = performance.now()
  signals.length = 0; f.registry.release(f.ref, 1); watcher.sync(1); await writeFile(bPath, 'B2')
  await expect.poll(() => signals.filter(event => event.type === 'external-change').length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(watches.size, `watch errors: ${watchErrors.join(', ')}`).toBe(1)
  if (process.env.INKNEST_WATCH_TIMING === '1') console.info(`watch-observation-ms replacement=${Math.round(replacementMs)} after-release=${Math.round(performance.now() - releasedAt)}`)
  expect(signals.some(event => event.type === 'external-change' && event.ref.docId === f.ref.docId)).toBe(false)
})

test('an inspected disk version cannot be silently replaced by a newer version before overwrite is clicked', async () => {
  const f = await setup(); const snapshot = f.state('local2', 1).snapshot!
  await writeFile(f.path, 'disk2'); await f.lifecycle.reconcileExternal(f.state('local2', 1), 1)
  expect(await f.lifecycle.resolveConflict(f.ref, 'inspect', snapshot, 1)).toMatchObject({ status: 'ok', value: { kind: 'inspection', text: 'disk2' } })
  await writeFile(f.path, 'disk3')
  expect(await f.lifecycle.resolveConflict(f.ref, 'overwrite', snapshot, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('disk3')
})

function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
test('reconcile barrier drains executing write, cancels queued writes and reloads only with frozen latest text', async () => {
  const started = gate(); const resume = gate(); let writes = 0
  const f = await setup(async (path, bytes, check) => { writes++; started.release(); await resume.wait; return atomicWrite(path, bytes, check) })
  const first = f.saves.save(f.request('local2', 1), 1); await started.wait
  const queued = f.saves.save(f.request('local3', 2), 1)
  const reconcile = f.lifecycle.reconcileExternal(f.state('local3', 2), 1)
  await writeFile(f.path, 'disk2'); resume.release()
  expect(await first).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await queued).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
  expect(await reconcile).toMatchObject({ status: 'ok', value: { kind: 'conflict', diskStatus: 'changed' } })
  expect(writes).toBe(1); expect(await readFile(f.path, 'utf8')).toBe('disk2'); expect(f.a.latestSnapshot?.text).toBe('local3')
})

test('SaveAs drains source before opening picker and holds later saves until target publication', async () => {
  const started = gate(); const resume = gate(); let writes = 0
  const f = await setup(async (path, bytes, check) => { if (++writes === 1) { started.release(); await resume.wait }; return atomicWrite(path, bytes, check) })
  const first = f.saves.save(f.request('local2', 1), 1); await started.wait
  const target = join(root, 'copy.md'); let pickerOpened = false
  const lifecycle = new FileLifecycle(f.registry, f.saves, { choosePath: async () => { pickerOpened = true; expect(await readFile(f.path, 'utf8')).toBe('local2'); return target }, confirm: async () => true })
  const copy = lifecycle.saveAs(f.request('local3', 2), 1)
  const last = f.saves.save(f.request('local4', 3), 1)
  expect(pickerOpened).toBe(false); resume.release()
  expect((await first).status).toBe('ok'); expect((await copy).status).toBe('ok'); expect((await last).status).toBe('ok')
  expect(await readFile(f.path, 'utf8')).toBe('local2'); expect(await readFile(target, 'utf8')).toBe('local4')
})

test('SaveAs rejects target creation and existing-target replacement races before the trusted atomic writer', async () => {
  const f = await setup(async (path, bytes, check) => { await writeFile(path, 'third-party'); return atomicWrite(path, bytes, check) })
  f.target(join(root, 'new.md'))
  expect(await f.lifecycle.saveAs(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('third-party'); expect(f.a.path).toBe(f.path)
  const target = join(root, 'existing.md'); await writeFile(target, 'original target'); f.target(target)
  expect(await f.lifecycle.saveAs(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(target, 'utf8')).toBe('third-party'); expect(await readFile(f.path, 'utf8')).toBe('disk1')
})

test('SaveAs to explicitly selected deleted source recreates only with picker authority and preserves source format', async () => {
  const f = await setup(); await rm(f.path); f.target(f.path)
  expect((await f.lifecycle.saveAs(f.request('new\nbody'), 1)).status).toBe('ok'); expect(await readFile(f.path, 'utf8')).toBe('new\nbody')
})

test.each(['link', 'permission'] as const)('readonly %s SaveAs permits only the registered snapshot and promotes only verified writable copy', async reason => {
  const original = join(root, 'original.md'); const path = join(root, 'readonly.md'); await writeFile(original, 'readonly source')
  if (reason === 'link') await link(original, path)
  else { await writeFile(path, 'readonly source'); await chmod(path, 0o444) }
  const registry = new DocumentRegistry(); await registry.open(path, 1); const source = registry.current!; expect(source.document.readOnlyReason).toBe(reason)
  const ref = { docId: source.document.docId, epoch: source.document.epoch }; const target = join(root, 'copy.md'); let selected: string | null = null
  const lifecycle = new FileLifecycle(registry, new SaveCoordinator(registry), { choosePath: async () => selected, confirm: async () => true })
  const request = (text = 'readonly source', revision = 0): SaveRequest => ({ requestId: randomUUID(), snapshot: { ...ref, text, revision }, expectedDiskToken: source.document.diskToken, trigger: 'manual' })
  expect(await lifecycle.saveAs(request(), 1)).toEqual({ status: 'cancelled' }); expect(source.document.readOnlyReason).toBe(reason)
  selected = path; expect(await lifecycle.saveAs(request(), 1)).toMatchObject({ status: 'error', error: { code: 'READ_ONLY' } })
  selected = target
  expect(await lifecycle.saveAs(request('forged'), 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  expect(await lifecycle.saveAs(request('readonly source', 1), 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  expect((await lifecycle.saveAs(request(), 1)).status).toBe('ok'); expect(source.document.readOnlyReason).toBeNull(); expect(source.document.epoch).toBe(ref.epoch)
  expect(await readFile(path, 'utf8')).toBe('readonly source'); expect(await readFile(target, 'utf8')).toBe('readonly source')
  expect((await new SaveCoordinator(registry).save({ ...request('copy edit', 1), expectedDiskToken: source.document.diskToken }, 1)).status).toBe('ok')
  expect(await readFile(target, 'utf8')).toBe('copy edit'); expect(await readFile(path, 'utf8')).toBe('readonly source')
})

test('SaveAs selecting its own source records known conflict independently of a matching saved baseline', async () => {
  const f = await setup(); expect((await f.saves.save(f.request(), 1)).status).toBe('ok')
  await writeFile(f.path, 'disk2'); f.target(f.path)
  expect(await f.lifecycle.saveAs(f.request(), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(f.a.diskStatus).toBe('changed'); expect(await readFile(f.path, 'utf8')).toBe('disk2')
})

test('failed explicit recreation through SaveAs preserves the known missing source for close protection', async () => {
  const f = await setup(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }); await rm(f.path); f.target(f.path)
  expect(await f.lifecycle.saveAs(f.request('disk1', 0), 1)).toMatchObject({ status: 'error', error: { code: 'ACCESS_DENIED' } })
  expect(f.a.diskStatus).toBe('missing'); expect(f.a.document.text).toBe('disk1')
})

for (const firstAction of ['overwrite', 'save-as'] as const) for (const nextAction of ['overwrite', 'use-disk'] as const) test(`resolved inspection via ${firstAction} does not reject the next ${nextAction} conflict`, async () => {
  const f = await setup(); const snapshot = f.state('local2', 1).snapshot!
  await writeFile(f.path, 'external1'); expect((await f.lifecycle.resolveConflict(f.ref, 'inspect', snapshot, 1)).status).toBe('ok')
  if (firstAction === 'overwrite') expect((await f.lifecycle.resolveConflict(f.ref, 'overwrite', snapshot, 1)).status).toBe('ok')
  else { f.target(join(root, 'copy.md')); expect((await f.lifecycle.saveAs(f.request(), 1)).status).toBe('ok') }
  await writeFile(f.a.path, 'external2')
  expect((await f.lifecycle.resolveConflict(f.ref, nextAction, f.state('local3', 2).snapshot!, 1)).status).toBe('ok')
  expect(await readFile(f.a.path, 'utf8')).toBe(nextAction === 'overwrite' ? 'local3' : 'external2')
})
test('cancelled SaveAs retains inspection protection against subsequent disk change', async () => {
  const f = await setup(); const snapshot = f.state('local2', 1).snapshot!
  await writeFile(f.path, 'external1'); await f.lifecycle.resolveConflict(f.ref, 'inspect', snapshot, 1)
  expect(await f.lifecycle.saveAs(f.request(), 1)).toEqual({ status: 'cancelled' }); await writeFile(f.path, 'external2')
  expect(await f.lifecycle.resolveConflict(f.ref, 'overwrite', snapshot, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('external2')
})

test('replayed successful SaveAs receipt cannot clear a later unresolved inspection', async () => {
  const f = await setup(); f.target(join(root, 'copy.md')); const request = f.request()
  expect((await f.lifecycle.saveAs(request, 1)).status).toBe('ok')
  const snapshot = f.state('local3', 2).snapshot!
  await writeFile(f.a.path, 'external1'); expect((await f.lifecycle.resolveConflict(f.ref, 'inspect', snapshot, 1)).status).toBe('ok')
  expect((await f.lifecycle.saveAs(request, 1)).status).toBe('ok')
  await writeFile(f.a.path, 'external2')
  expect(await f.lifecycle.resolveConflict(f.ref, 'overwrite', snapshot, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.a.path, 'utf8')).toBe('external2')
})
