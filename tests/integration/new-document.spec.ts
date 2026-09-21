import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AppEvent, ContentSnapshot, SaveRequest } from '../../src/shared/contracts'
import { DocumentRegistry, type DocumentSession } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { FileLifecycle } from '../../src/main/documents/file-lifecycle'
import { DirectoryWatcher } from '../../src/main/documents/watcher'
import { RecoveryStore } from '../../src/main/documents/recovery-store'
import { HistoryStore } from '../../src/main/documents/history-store'
import { BackupCoordinator } from '../../src/main/documents/backup-coordinator'
import { CloseCoordinator } from '../../src/main/documents/close-coordinator'
import { WorkspaceCloseCoordinator } from '../../src/main/documents/workspace-close-coordinator'
import { atomicWrite, type AtomicWriter } from '../../src/main/documents/atomic-writer'
import { ResourceService } from '../../src/main/security/resource-protocol'
import { LinkRouter } from '../../src/main/documents/link-router'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-new-'))) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
function create(registry: DocumentRegistry) {
  const result = registry.create(1)
  if (result.status !== 'ok') throw new Error('create failed')
  return registry.get(result.value, 1)!
}
const snapshot = (session: DocumentSession, text: string, revision = 1): ContentSnapshot => ({ docId: session.document.docId, epoch: session.document.epoch, text, revision })
const request = (session: DocumentSession, text: string, revision = 1): SaveRequest => ({ requestId: randomUUID(), snapshot: snapshot(session, text, revision), expectedDiskToken: session.document.diskToken, trigger: 'manual' })
function fixture(writer: AtomicWriter = atomicWrite, beforeManifest?: () => void) {
  const registry = new DocumentRegistry(), session = create(registry)
  const recovery = new RecoveryStore(join(root, 'recovery'), registry, { beforeManifest })
  const history = new HistoryStore(join(root, 'history'))
  const saves = new SaveCoordinator(registry, writer, { history, recovery })
  let target: string | null = join(root, 'new.md')
  const choose = vi.fn(async () => target), confirm = vi.fn(async () => true)
  const lifecycle = new FileLifecycle(registry, saves, { choosePath: choose, confirm }, recovery)
  return { registry, session, recovery, history, saves, lifecycle, choose, confirm, target: (path: string | null) => { target = path } }
}

test('new identities have no disk grants, monotonically numbered names and atomic 20-tab admission', async () => {
  const registry = new DocumentRegistry(), first = create(registry), second = create(registry)
  expect(first.document).toMatchObject({ displayName: '未命名-1', displayPath: null, diskToken: null, text: '', revision: 0, recovered: false, format: { encoding: 'utf-8', bom: false, eol: 'lf' } })
  expect(second.document.displayName).toBe('未命名-2')
  expect(registry.findPath('')).toBeUndefined()
  registry.release(first.document, 1)
  expect(create(registry).document.displayName).toBe('未命名-3')
  for (let i = 2; i < 20; i++) create(registry)
  expect(registry.create(1)).toMatchObject({ status: 'error', error: { code: 'TAB_LIMIT' } })
  expect(registry.list(1)).toHaveLength(20)
  expect(registry.get(second.document, 2)).toBeUndefined()
  expect(registry.create(-1).status).toBe('error')
  expect(await readdir(root)).toEqual([])
})

test.each(['', '# 中文\n', ' \n'])('first save retains exact UTF-8 source %j, identity and one sealed history node', async text => {
  const f = fixture(), id = { docId: f.session.document.docId, epoch: f.session.document.epoch }
  f.target(join(root, '中文'))
  const result = await f.lifecycle.saveAs(request(f.session, text, text ? 1 : 0), 1)
  expect(result).toMatchObject({ status: 'ok', value: { ref: id, displayName: '中文.md', history: { state: 'recorded' } } })
  expect(await readFile(join(root, '中文.md'))).toEqual(Buffer.from(text))
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.choose).toHaveBeenCalledWith('未命名-1.md', true)
  expect(f.registry.get(id, 1)).toBe(f.session)
  expect(f.registry.suggestedDirectory).toBe(root)
  expect((await f.history.list(f.session)).entries).toMatchObject([{ sealed: true, source: 'save-as' }])
  expect(await f.recovery.list()).toEqual([])
})

test('cancel, invalid extensions, stale identity, malformed text and ordinary autosave retain the draft', async () => {
  const f = fixture()
  f.target(null)
  expect(await f.lifecycle.saveAs(request(f.session, 'A'), 1)).toEqual({ status: 'cancelled' })
  for (const name of ['a.txt', 'a.md.exe']) {
    f.target(join(root, name))
    expect(await f.lifecycle.saveAs(request(f.session, 'A'), 1)).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_TYPE' } })
  }
  expect(await f.saves.save({ ...request(f.session, 'A'), trigger: 'auto' }, 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  expect(await f.lifecycle.saveAs(request(f.session, 'A'), 2)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
  expect(await f.lifecycle.saveAs(request(f.session, '\ud800', 2), 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  expect(await f.lifecycle.saveAs(request(f.session, 'x'.repeat(2 * 1024 * 1024 + 1), 2), 1)).toMatchObject({ status: 'error' })
  expect(f.session.document.displayPath).toBeNull()
  expect(f.session.diskStatus).toBe('current')
  expect(await readdir(root)).toEqual([])
})

test('same request shares one chooser and replays the confirmed first-save receipt without writing again', async () => {
  let writes = 0
  const f = fixture(async (...args) => { writes++; return atomicWrite(...args) })
  const r = request(f.session, 'A')
  const [first, duplicate] = await Promise.all([f.lifecycle.saveAs(r, 1), f.lifecycle.saveAs(r, 1)])
  expect(first).toEqual(duplicate); expect(first.status).toBe('ok')
  expect(await f.lifecycle.saveAs(r, 1)).toEqual(first)
  expect(f.choose).toHaveBeenCalledTimes(1); expect(writes).toBe(1)
  expect(await f.lifecycle.saveAs({ ...r, snapshot: { ...r.snapshot, text: 'forged' } }, 1)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
})

test('two independent drafts serialize the same destination and cannot overwrite an opened target', async () => {
  const f = fixture(), other = create(f.registry)
  const results = await Promise.all([f.lifecycle.saveAs(request(f.session, 'A'), 1), f.lifecycle.saveAs(request(other, 'B'), 1)])
  expect(results.map(r => r.status)).toEqual(['ok', 'error'])
  expect(results[1]).toMatchObject({ error: { code: 'TARGET_OPEN' } })
  expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('A')
  expect(other.document.displayPath).toBeNull()
})

test('independent destinations do not share a fictitious empty-path write lock', async () => {
  const f = fixture(), other = create(f.registry)
  let finish!: () => void
  const first = f.registry.serializeWrite(f.session, () => new Promise<void>(resolve => { finish = resolve }), join(root, 'a.md'))
  await Promise.resolve(); await Promise.resolve()
  let secondRan = false
  const second = f.registry.serializeWrite(other, async () => { secondRan = true }, join(root, 'b.md'))
  await second
  expect(secondRan).toBe(true)
  finish(); await first
})

test.each(['ENOSPC', 'EACCES', 'EBUSY'])('%s first-write failure preserves source, recovery and null identity', async code => {
  const f = fixture(async () => { throw Object.assign(new Error('injected'), { code }) })
  const r = request(f.session, 'keep')
  await f.recovery.checkpoint(f.session, r.snapshot)
  expect((await f.lifecycle.saveAs(r, 1)).status).toBe('error')
  expect(f.session.document.displayPath).toBeNull()
  expect(f.session.latestSnapshot?.text).toBe('keep')
  expect(await f.recovery.inspect((await f.recovery.list())[0]!.id)).toBe('keep')
})

test('replacement confirmation binds old bytes; newly created targets and replaced parents cancel writing', async () => {
  const f = fixture()
  const target = join(root, 'new.md'); await writeFile(target, 'old')
  f.confirm.mockImplementationOnce(async () => { await writeFile(target, 'external'); return true })
  expect(await f.lifecycle.saveAs(request(f.session, 'local'), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(target, 'utf8')).toBe('external')
  const parent = join(root, 'parent'); await mkdir(parent)
  const g = fixture(async (path, bytes, check) => {
    await rename(parent, join(root, 'previous-parent')); await mkdir(parent)
    return atomicWrite(path, bytes, check)
  })
  g.target(join(parent, 'new.md'))
  expect(await g.lifecycle.saveAs(request(g.session, 'local'), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readdir(parent)).toEqual([])
  const h = fixture(async (path, bytes, check) => { await writeFile(path, 'external-new'); return atomicWrite(path, bytes, check) })
  h.target(join(root, 'appeared.md'))
  expect(await h.lifecycle.saveAs(request(h.session, 'local'), 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(join(root, 'appeared.md'), 'utf8')).toBe('external-new')
})

test('overwrite preserves old bytes and first-save history failure reports the confirmed file separately', async () => {
  const f = fixture(); await writeFile(join(root, 'new.md'), 'old')
  expect((await f.lifecycle.saveAs(request(f.session, 'new'), 1)).status).toBe('ok')
  const entries = (await f.history.list(f.session)).entries
  expect(await f.history.read(f.session, entries[1]!.id)).toEqual(Buffer.from('old'))
  const g = fixture(); g.target(join(root, 'history-failure.md'))
  vi.spyOn(g.history, 'recordSaved').mockRejectedValueOnce(new Error('history failed'))
  expect(await g.lifecycle.saveAs(request(g.session, 'saved'), 1)).toMatchObject({ status: 'ok', value: { history: { state: 'failed' } } })
  expect(await readFile(join(root, 'history-failure.md'), 'utf8')).toBe('saved')
  expect(await g.saves.save({ ...request(g.session, 'later', 2), trigger: 'auto' }, 1)).toMatchObject({ status: 'error', error: { code: 'HISTORY_FAILED' } })
})

test('fresh drafts never watch cwd, load relative resources or read disk history; first save establishes the base', async () => {
  const f = fixture(), events: AppEvent[] = [], watcher = new DirectoryWatcher(f.registry, e => events.push(e))
  try {
    watcher.sync(1); await watcher.check(f.session)
    expect(events).toEqual([])
    expect(await f.lifecycle.reconcileExternal({ ref: f.session.document, snapshot: snapshot(f.session, '', 0) }, 1)).toEqual({ status: 'ok', value: { kind: 'unchanged' } })
    expect((await f.history.list(f.session)).entries).toEqual([])
    expect(await readdir(root)).toEqual([])
    const resources = new ResourceService(f.registry, () => 1)
    expect(await resources.resolve(f.session, [{ key: '0', rawTarget: 'image.png' }])).toMatchObject([{ blockedReason: 'unsaved' }])
    const links = new LinkRouter(f.registry, resources, { blocked: () => false, external: async () => {}, directory: async () => '', reveal() {} })
    expect(await links.open(f.session.document, '#title', 1)).toMatchObject({ status: 'ok', value: { kind: 'anchor' } })
    expect(await links.open(f.session.document, 'other.md', 1)).toMatchObject({ status: 'error', error: { message: '请先保存文档，再打开相对链接' } })
    await writeFile(join(root, 'other.md'), '# other')
    await f.lifecycle.saveAs(request(f.session, '# source'), 1)
    expect(await links.open(f.session.document, 'other.md', 1)).toMatchObject({ status: 'ok', value: { kind: 'document' } })
  } finally { watcher.dispose() }
})

test('multiple unnamed recoveries remain independent; clearing publishes an empty latest snapshot and can be edited again', async () => {
  const f = fixture(), b = create(f.registry)
  await f.recovery.checkpoint(f.session, snapshot(f.session, 'A'))
  await f.recovery.checkpoint(b, snapshot(b, 'B'))
  const records = await f.recovery.list()
  await f.recovery.checkpoint(f.session, snapshot(f.session, '', 2))
  expect(await new RecoveryStore(join(root, 'recovery'), new DocumentRegistry()).list()).toHaveLength(1)
  await f.recovery.checkpoint(f.session, snapshot(f.session, 'A again', 3))
  f.registry.close()
  const registry = new DocumentRegistry(), recovery = new RecoveryStore(join(root, 'recovery'), registry)
  const backups = new BackupCoordinator(registry, new SaveCoordinator(registry), recovery, f.history, { choosePath: async () => null, confirm: async () => false })
  for (const entry of records) expect((await backups.restore(entry.id, 1)).status).toBe('ok')
  const sessions = registry.list(1)
  expect(sessions.map(s => s.latestSnapshot?.text).sort()).toEqual(['A again', 'B'])
  expect(sessions.map(s => s.document.displayName)).toEqual(['未命名-1', '未命名-2'])
  expect(sessions.every(s => s.document.displayPath === null && s.diskStatus === 'current')).toBe(true)
})

test('saving A preserves the later B recovery revision and assigns its successful target', async () => {
  const f = fixture(async (...args) => { await f.recovery.checkpoint(f.session, snapshot(f.session, 'B', 2)); return atomicWrite(...args) })
  await f.recovery.checkpoint(f.session, snapshot(f.session, 'A'))
  expect((await f.lifecycle.saveAs(request(f.session, 'A'), 1)).status).toBe('ok')
  expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('A')
  const recovered = await f.recovery.load((await f.recovery.list())[0]!.id)
  expect(recovered).toMatchObject({ text: 'B', revision: 2, manifest: { originalPath: join(root, 'new.md') } })
})

function closingFixture() {
  let failManifest = false
  const f = fixture(atomicWrite, () => { if (failManifest) throw new Error('manifest failure') })
  let choice: 'save' | 'discard' | 'cancel' = 'cancel', discard = false
  const texts = new Map<string, ContentSnapshot>([[f.session.document.docId, snapshot(f.session, 'draft')]])
  const events: AppEvent[] = []
  const send = (event: AppEvent) => {
    events.push(event)
    if (event.type === 'prepare-close') void workspace.complete(event.requestId, { ref: event.ref, snapshot: texts.get(event.ref.docId)! })
  }
  const close = new CloseCoordinator(f.registry, send, async () => 'cancel', f.saves, f.recovery, async () => discard)
  const workspace = new WorkspaceCloseCoordinator(f.registry, 1, send, close, f.saves, f.recovery)
  const choose = vi.fn(async () => choice)
  workspace.configureUntitled({ choose, save: (r, owner) => f.lifecycle.saveAs(r, owner) })
  return { ...f, workspace, texts, events, choose, decision: (value: typeof choice, confirmed = false) => { choice = value; discard = confirmed }, failManifest: (value: boolean) => { failManifest = value } }
}

test('blank closes without prompt; whitespace is protected; save cancellation and successful save-then-close', async () => {
  const f = closingFixture()
  f.texts.set(f.session.document.docId, snapshot(f.session, ' ', 1))
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('cancelled')
  expect(f.choose).toHaveBeenCalledTimes(1)
  f.decision('save'); f.target(null)
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('cancelled')
  expect(f.registry.has(f.session)).toBe(true)
  f.target(join(root, 'closed.md'))
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('ok')
  expect(await readFile(join(root, 'closed.md'), 'utf8')).toBe(' ')
  expect(f.registry.has(f.session)).toBe(false)
  const blank = create(f.registry); f.texts.set(blank.document.docId, snapshot(blank, '', 0))
  f.choose.mockClear()
  expect((await f.workspace.closeDocument(blank.document)).status).toBe('ok')
  expect(f.choose).not.toHaveBeenCalled()
})

test('discard and blank-close maintenance failures retain the session; successful marker blocks late checkpoints', async () => {
  const f = closingFixture()
  await f.recovery.checkpoint(f.session, f.texts.get(f.session.document.docId)!)
  f.decision('discard', false)
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('cancelled')
  f.decision('discard', true); f.failManifest(true)
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('error')
  expect(f.registry.has(f.session)).toBe(true)
  f.texts.set(f.session.document.docId, snapshot(f.session, '', 2))
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('error')
  expect(f.registry.has(f.session)).toBe(true)
  f.texts.set(f.session.document.docId, snapshot(f.session, 'draft', 3)); f.failManifest(false)
  expect((await f.workspace.closeDocument(f.session.document)).status).toBe('ok')
  expect(await f.recovery.list()).toEqual([])
  await expect(f.recovery.checkpoint(f.session, snapshot(f.session, 'late', 4))).rejects.toBeDefined()
})

test('whole-window exit stops at nonempty untitled source without prompting or releasing any tabs', async () => {
  const f = closingFixture(), empty = create(f.registry)
  f.texts.set(empty.document.docId, snapshot(empty, '', 0))
  expect(await f.workspace.closeWindow()).toBe(false)
  expect(f.registry.list(1)).toHaveLength(2)
  expect(f.choose).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'close-blocked', ref: expect.objectContaining({ docId: f.session.document.docId }), action: 'save-as' }))
  f.texts.set(f.session.document.docId, snapshot(f.session, '', 2))
  expect(await f.workspace.closeWindow()).toBe(true)
  expect(f.registry.list(1)).toEqual([])
})
