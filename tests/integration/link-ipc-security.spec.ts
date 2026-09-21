import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { LinkRequest } from '../../src/shared/contracts'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { ResourceService } from '../../src/main/security/resource-protocol'
import type { WorkspaceCloseCoordinator } from '../../src/main/documents/workspace-close-coordinator'
import { registerLinkHandlers } from '../../src/main/ipc/links'

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  dispatches: [] as string[]
}))
// Only Electron's host boundary is substituted. Registry, schema, trust checks,
// link routing and resource services below are the production implementations.
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => boundary.handlers.set(channel, handler), removeHandler: (channel: string) => boundary.handlers.delete(channel) },
  shell: { openExternal: async (url: string) => { boundary.dispatches.push(url) }, openPath: async (path: string) => { boundary.dispatches.push(path); return '' }, showItemInFolder: (path: string) => { boundary.dispatches.push(path) } }
}))
let root: string
let registry: DocumentRegistry
let request: LinkRequest
let owner: { id: number; mainFrame: { url: string }; send: () => void }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inknest-link-ipc-'))
  const path = join(root, 'a.md'); await writeFile(path, '# A')
  registry = new DocumentRegistry(); const opened = await registry.open(path, 1)
  if (opened.status !== 'ok') throw new Error('fixture failed')
  request = { requestId: randomUUID(), ref: { docId: opened.value.docId, epoch: opened.value.epoch }, rawTarget: 'https://example.invalid/intentional' }
  owner = { id: 1, mainFrame: { url: 'inknest://app/' }, send: () => {} }
  const window = { webContents: owner, isDestroyed: () => false, once: () => {} } as unknown as BrowserWindow
  const close = { active: false, admission: async <T>(operation: () => Promise<T>) => operation() } as unknown as WorkspaceCloseCoordinator
  boundary.dispatches.length = 0
  registerLinkHandlers(window, registry, new ResourceService(registry, () => owner.id), close, () => {})
})
afterEach(async () => { boundary.handlers.clear(); await rm(root, { recursive: true, force: true }) })
function invoke(event: unknown, ...args: unknown[]) { return boundary.handlers.get('document:link')!(event, ...args) }
const trusted = () => ({ sender: owner, senderFrame: owner.mainFrame })

test('document:link dispatches only for the exact trusted main frame', async () => {
  for (const event of [
    { sender: {}, senderFrame: owner.mainFrame },
    { sender: owner, senderFrame: { url: owner.mainFrame.url } },
    { sender: owner, senderFrame: null }
  ]) expect(await invoke(event, request)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  for (const url of ['https://example.invalid/', 'inknest://other/', 'inknest://app/other', 'inknest://app/?path=secret', 'inknest://user@app/']) {
    owner.mainFrame.url = url
    expect(await invoke(trusted(), request)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  }
  expect(boundary.dispatches).toEqual([])
  owner.mainFrame.url = 'inknest://app/'
  expect(await invoke(trusted(), request)).toEqual({ status: 'ok', value: { kind: 'dispatched' } })
  expect(boundary.dispatches).toEqual(['https://example.invalid/intentional'])
})
test('document:link rejects extra arguments, paths, nested fields and oversized targets before dispatch', async () => {
  for (const args of [
    [], [request, true], [{ ...request, path: '/private/secret.md' }],
    [{ ...request, ref: { ...request.ref, ownerId: 1 } }],
    [{ ...request, requestId: 'not-a-uuid' }],
    [{ ...request, rawTarget: 'x'.repeat(4097) }], [{ ...request, rawTarget: '' }],
    [{ ...request, rawTarget: null }]
  ]) expect(await invoke(trusted(), ...args)).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
  expect(boundary.dispatches).toEqual([])
  expect(registry.list(1)).toHaveLength(1)
})
test('document:link rejects a foreign owner, stale epoch and released source without dispatch', async () => {
  owner.id = 2
  expect(await invoke(trusted(), request)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
  owner.id = 1
  expect(await invoke(trusted(), { ...request, ref: { ...request.ref, epoch: randomUUID() } })).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
  registry.release(request.ref, 1)
  expect(await invoke(trusted(), request)).toMatchObject({ status: 'error', error: { code: 'STALE_SESSION' } })
  expect(boundary.dispatches).toEqual([])
})
