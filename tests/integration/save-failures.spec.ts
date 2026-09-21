import fs from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { SaveCoordinator } from '../../src/main/documents/save-coordinator'
import { atomicWrite } from '../../src/main/documents/atomic-writer'
import { WorkspaceCloseCoordinator } from '../../src/main/documents/workspace-close-coordinator'
import { CloseCoordinator } from '../../src/main/documents/close-coordinator'
import type { AppEvent, SaveRequest } from '../../src/shared/contracts'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inknest-save-fault-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function setup() {
  const path = join(root, 'doc.md'); await writeFile(path, 'old complete bytes')
  const registry = new DocumentRegistry(); await registry.open(path, 1)
  const ref = { docId: registry.current!.document.docId, epoch: registry.current!.document.epoch }
  const request: SaveRequest = { requestId: randomUUID(), snapshot: { ...ref, revision: 1, text: 'new complete bytes' }, expectedDiskToken: registry.current!.document.diskToken, trigger: 'manual' }
  return { path, registry, ref, request }
}

test.each([['ENOSPC', 'DISK_FULL'], ['EACCES', 'ACCESS_DENIED']])('TC-034 temporary write %s preserves complete original bytes', async (code, errorCode) => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry)
  // Inject at the real library's callback fs.write boundary, after staging was opened.
  vi.spyOn(fs, 'write').mockImplementationOnce((...args: unknown[]) => { (args.at(-1) as (error: Error) => void)(Object.assign(new Error('injected'), { code })) })
  expect(await saves.save(f.request, 1)).toMatchObject({ status: 'error', error: { code: errorCode } })
  expect(await readFile(f.path, 'utf8')).toBe('old complete bytes')
  expect(f.registry.current!.latestSnapshot?.text).toBe('new complete bytes')
})

test('TC-034 occupied target rejects replacement after a complete staged file and preserves original', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); let staged = ''
  vi.spyOn(fs, 'rename').mockImplementationOnce((from, _to, callback) => { staged = fs.readFileSync(from, 'utf8'); callback(Object.assign(new Error('occupied'), { code: 'EBUSY' })) })
  expect(await saves.save(f.request, 1)).toMatchObject({ status: 'error', error: { code: 'FILE_BUSY' } })
  expect(staged).toBe('new complete bytes'); expect(await readFile(f.path, 'utf8')).toBe('old complete bytes')
})

test('interruption after replacement leaves complete new bytes but never acknowledges an unconfirmed save', async () => {
  const f = await setup()
  const saves = new SaveCoordinator(f.registry, async (...args) => { await atomicWrite(...args); throw new Error('interrupt before receipt') })
  expect((await saves.save(f.request, 1)).status).toBe('error')
  expect(await readFile(f.path, 'utf8')).toBe('new complete bytes')
  expect(f.registry.current!.document.text).toBe('old complete bytes')
  expect(f.registry.current!.latestSnapshot?.text).toBe('new complete bytes')
  expect(await saves.save({ ...f.request, requestId: randomUUID() }, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
})

test('deletion and post-replacement external writes never silently recreate or acknowledge another writer', async () => {
  const f = await setup(); await rm(f.path)
  expect(await new SaveCoordinator(f.registry).save(f.request, 1)).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(f.path, 'old complete bytes'); f.registry.close(); await f.registry.open(f.path, 1)
  const current = f.registry.current!.document
  const request = { ...f.request, snapshot: { ...f.request.snapshot, docId: current.docId, epoch: current.epoch }, expectedDiskToken: current.diskToken }
  const saves = new SaveCoordinator(f.registry, async (...args) => { const identity = await atomicWrite(...args); await writeFile(f.path, 'external after rename'); return identity })
  expect(await saves.save(request, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await readFile(f.path, 'utf8')).toBe('external after rename')
})

test('close waits for accepted A, then saves frozen B and emits its exact receipt', async () => {
  const f = await setup(); let release!: () => void; let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve }); const resume = new Promise<void>((resolve) => { release = resolve })
  let writes = 0
  const saves = new SaveCoordinator(f.registry, async (...args) => { if (++writes === 1) { started(); await resume }; return atomicWrite(...args) })
  const saving = saves.save(f.request, 1); await began
  const events: AppEvent[] = []; const close = new CloseCoordinator(f.registry, (event) => events.push(event), async () => 'cancel', saves)
  const prepared = close.prepare(); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing close challenge')
  const completing = close.complete(event.requestId, { ref: f.ref, snapshot: { ...f.ref, revision: 2, text: 'frozen B' } })
  let resolved = false; void prepared.then(() => { resolved = true })
  await new Promise((resolve) => setTimeout(resolve, 10)); expect(resolved).toBe(false)
  release(); await saving; expect((await completing).status).toBe('ok'); expect(await prepared).toBe(true)
  expect(await readFile(f.path, 'utf8')).toBe('frozen B')
  expect(events).toContainEqual(expect.objectContaining({ type: 'save-receipt', receipt: expect.objectContaining({ requestId: event.requestId, savedRevision: 2 }) }))
  close.finish()
})

test('close Save failure preserves session and denies close', async () => {
  const f = await setup(); const saves = new SaveCoordinator(f.registry); const events: AppEvent[] = []
  const close = new CloseCoordinator(f.registry, (event) => events.push(event), async () => 'cancel', saves)
  const prepared = close.prepare(); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing close challenge')
  await writeFile(f.path, 'external')
  expect(await close.complete(event.requestId, { ref: f.ref, snapshot: f.request.snapshot })).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(await prepared).toBe(false); expect(f.registry.current!.latestSnapshot?.text).toBe('new complete bytes'); close.finish()
})


test.each(['before', 'after'])('SIGKILL %s library rename leaves one complete document version', async (boundary) => {
  const f = await setup()
  const child = fork('-e', [`
    const fs = require('node:fs'); const original = fs.rename;
    fs.rename = (from, to, callback) => {
      if (process.env.BOUNDARY === 'before') process.send('boundary');
      else original(from, to, (error) => { if (error) throw error; process.send('boundary') });
    };
    require('write-file-atomic')(process.env.TARGET, 'new complete bytes', { fsync: true });
    setInterval(() => {}, 1000);
  `], { cwd: process.cwd(), env: { ...process.env, TARGET: f.path, BOUNDARY: boundary }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('child exited before boundary') })])
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    expect(await readFile(f.path, 'utf8')).toBe(boundary === 'before' ? 'old complete bytes' : 'new complete bytes')
  } finally { child.kill('SIGKILL') }
})

test('close settles A and automatically saves undo back to old disk bytes', async () => {
  const f = await setup(); let release!: () => void; let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve }); const resume = new Promise<void>((resolve) => { release = resolve })
  const saves = new SaveCoordinator(f.registry, async (...args) => { started(); await resume; return atomicWrite(...args) })
  const saving = saves.save(f.request, 1); await began
  const events: AppEvent[] = []; let prompts = 0
  const close = new CloseCoordinator(f.registry, (event) => events.push(event), async () => { prompts++; return 'cancel' }, saves)
  const prepared = close.prepare(); const event = events.find(event => event.type === 'prepare-close')!
  if (event.type !== 'prepare-close') throw new Error('missing challenge')
  const completing = close.complete(event.requestId, { ref: f.ref, snapshot: { ...f.ref, revision: 2, text: 'old complete bytes' } })
  let resolved = false; void prepared.then(() => { resolved = true })
  await new Promise((resolve) => setTimeout(resolve, 10)); expect(resolved).toBe(false); expect(prompts).toBe(0)
  release(); await saving; await completing
  expect(await prepared).toBe(true); expect(prompts).toBe(0)
  expect(await readFile(f.path, 'utf8')).toBe('old complete bytes'); close.finish()
})


test('post-replace same-byte external identity is not promoted into our successful save chain', async () => {
  const f = await setup()
  const saves = new SaveCoordinator(f.registry, async (...args) => {
    const identity = await atomicWrite(...args)
    const replacement = join(root, 'external.md'); await writeFile(replacement, 'new complete bytes'); await rename(replacement, f.path)
    return identity
  })
  expect(await saves.save(f.request, 1)).toMatchObject({ status: 'error', error: { code: 'EXTERNAL_CHANGE' } })
  expect(f.registry.current!.document.text).toBe('old complete bytes')
  expect(await readFile(f.path, 'utf8')).toBe('new complete bytes')
})


test.skipIf(process.platform === 'win32')('permission removed after opening is reported as access denied without changing bytes', async () => {
  const f = await setup(); await chmod(f.path, 0o444)
  expect(await new SaveCoordinator(f.registry).save(f.request, 1)).toMatchObject({ status: 'error', error: { code: 'ACCESS_DENIED' } })
  expect(await readFile(f.path, 'utf8')).toBe('old complete bytes')
})

test('whole-window close checks all clean sessions before accepting', async () => {
  const f = await setup()
  const other = join(root, 'other.md'); await writeFile(other, 'other'); await f.registry.open(other, 1)
  const events: AppEvent[] = []
  const saves = new SaveCoordinator(f.registry)
  const documentClose = new CloseCoordinator(f.registry, event => events.push(event), async () => 'cancel', saves)
  const close = new WorkspaceCloseCoordinator(f.registry, 1, event => events.push(event), documentClose, saves, { afterSave: async () => {} })
  const pending = close.closeWindow()
  for (const session of f.registry.list(1)) {
    const event = events.filter(event => event.type === 'prepare-close').at(-1)!
    if (event.type !== 'prepare-close') throw new Error('missing challenge')
    await close.complete(event.requestId, { ref: event.ref, snapshot: { ...event.ref, text: session.document.text, revision: 0 } })
    await Promise.resolve()
  }
  expect(await pending).toBe(true)
  expect(f.registry.list(1)).toHaveLength(0)
  close.finish()
})
