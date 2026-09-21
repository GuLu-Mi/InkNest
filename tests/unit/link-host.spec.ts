import { createRenderer, ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppEvent, LinkOutcome, OpenDocument, Result, SessionRef } from '../../src/shared/contracts'
import { useWorkspace } from '../../src/renderer/src/documents/use-workspace'
const source: OpenDocument = { docId: 'a', epoch: 'a', displayName: 'a.md', displayPath: '/a.md', text: '# A', revision: 0, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, diskToken: 'a', readOnlyReason: null, recovered: false, readingPosition: null }
const target = { ...source, docId: 'b', epoch: 'b', displayName: 'b.md', displayPath: '/b.md' }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
function fixture() {
  let event!: (event: AppEvent) => Promise<void>; let requestId = ''
  let response = async (): Promise<Result<LinkOutcome>> => ({ status: 'ok', value: { kind: 'document', document: target, fragment: 'target' } })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, inknest: {
    onEvent: (handler: typeof event) => { event = handler; return () => {} },
    openDocumentLink: async (request: { requestId: string }) => { requestId = request.requestId; return response() },
    activateDocument: async (ref: SessionRef) => { await event({ type: 'document-activated', ref }); return { status: 'ok', value: undefined } }
  } })
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let ws!: ReturnType<typeof useWorkspace>
  const app = renderer.createApp({ setup() { ws = useWorkspace(ref(undefined)); return () => null } }); app.mount({}); cleanups.push(() => app.unmount())
  ws.workspace.install({ ...source })
  return { ws, event: (value: AppEvent) => event(value), id: () => requestId, respond: (value: typeof response) => { response = value } }
}
test('an owned activation event does not invalidate its own navigation and late receipts cannot resurrect a closed tab', async () => {
  const f = fixture(); let valid = true
  const stop = f.ws.workspace.subscribe(() => { if (f.ws.workspace.active?.docId !== source.docId) valid = false }); cleanups.push(stop)
  expect(await f.ws.openLinked('b.md#target', () => valid)).toMatchObject({ status: 'ok', value: { fragment: 'target' } })
  expect(f.ws.workspace.active?.docId).toBe('b')
  f.ws.workspace.remove(target)
  await f.event({ type: 'link-opened', requestId: f.id(), document: target })
  expect(f.ws.workspace.get(target)).toBeNull()
})
test('a late open response registers in background without selecting after source intent changed', async () => {
  const f = fixture(); let valid = true
  f.respond(async () => { valid = false; return { status: 'ok', value: { kind: 'document', document: target, fragment: '' } } })
  expect(await f.ws.openLinked('b.md', () => valid)).toEqual({ status: 'cancelled' })
  expect(f.ws.workspace.active?.docId).toBe('a'); expect(f.ws.workspace.get(target)).toBeDefined()
})
