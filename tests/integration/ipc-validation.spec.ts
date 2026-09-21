import { expect, test } from 'vitest'
import { isTrustedCaller, validCloseArgs, validConflictArgs, validReconcileArgs, validActivateArgs, validResourceArgs, validSaveArgs } from '../../src/main/ipc/validation'

test('only the owned main frame and exact application page can invoke privileged methods', () => {
  const mainFrame = { url: 'inknest://app/' }; const owner = { mainFrame }
  expect(isTrustedCaller({ sender: owner, senderFrame: mainFrame }, owner)).toBe(true)
  expect(isTrustedCaller({ sender: {}, senderFrame: mainFrame }, owner)).toBe(false)
  expect(isTrustedCaller({ sender: owner, senderFrame: { url: mainFrame.url } }, owner)).toBe(false)
  for (const url of ['other://app/', 'inknest://evil/', 'inknest://app/other', 'inknest://user@app/', 'inknest://app:99/', 'inknest://app/?x', 'file:///tmp/a']) {
    mainFrame.url = url
    expect(isTrustedCaller({ sender: owner, senderFrame: mainFrame }, owner), url).toBe(false)
  }
})
test('resource IPC refuses unknown fields, stale-shaped IDs and excessive batches/targets', () => {
  const ref = { docId: '12345678-1234-1234-1234-123456789abc', epoch: 'abcdef12-1234-1234-1234-123456789abc' }
  expect(validResourceArgs([ref, [{ key: '0', rawTarget: 'p.png' }]])).toBe(true)
  for (const args of [[], [ref], [ref, [], 'extra'], [{ ...ref, path: '/etc' }, []], [{ ...ref, docId: '' }, []], [ref, [{ key: 'x', rawTarget: 'x', unknown: true }]], [ref, [{ key: 'x', rawTarget: 'x'.repeat(4097) }]], [ref, Array.from({length: 201}, () => ({ key: 'x', rawTarget: 'p.png' }))]]) {
    expect(validResourceArgs(args)).toBe(false)
  }
})

test('close IPC validates exact snapshot shape and rejects booleans, oversized text and invalid revisions', () => {
  const ref = { docId: '12345678-1234-1234-1234-123456789abc', epoch: 'abcdef12-1234-1234-1234-123456789abc' }
  const state = { ref, snapshot: { ...ref, revision: 1, text: '最新修改' } }
  expect(validCloseArgs([ref.docId, state])).toBe(true)
  expect(validCloseArgs([ref.docId, { ref, snapshot: null }])).toBe(true)
  for (const value of [true, { ...state, dirty: false }, { ...state, snapshot: { ...state.snapshot, revision: -1 } }, { ...state, snapshot: { ...state.snapshot, revision: 1.5 } }, { ...state, snapshot: { ...state.snapshot, revision: Number.MAX_SAFE_INTEGER + 1 } }, { ...state, snapshot: { ...state.snapshot, text: 'x'.repeat(2 * 1024 * 1024 + 1) } }, { ...state, snapshot: { ...state.snapshot, path: '/tmp/test' } }]) {
    expect(validCloseArgs([ref.docId, value])).toBe(false)
  }
})


test('save IPC rejects path/force/format injection, unknown trigger, bad token and malformed snapshots', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const request = { requestId: id, snapshot: { docId: id, epoch: id, revision: 1, text: 'source' }, expectedDiskToken: 'a'.repeat(64), trigger: 'manual' }
  expect(validSaveArgs([request])).toBe(true)
  expect(validSaveArgs([{ ...request, trigger: 'auto' }])).toBe(true)
  for (const invalid of [null, { ...request, path: '/tmp/elsewhere' }, { ...request, force: true }, { ...request, format: {} }, { ...request, trigger: 'unknown' }, { ...request, expectedDiskToken: 'untrusted' }, { ...request, requestId: '' }, { ...request, snapshot: { ...request.snapshot, revision: -1 } }, { ...request, snapshot: { ...request.snapshot, text: null } }]) expect(validSaveArgs([invalid])).toBe(false)
  expect(validSaveArgs([request, request])).toBe(false)
})


test('activation accepts only one exact SessionRef and rejects path injection', () => {
  const ref = { docId: '12345678-1234-1234-1234-123456789abc', epoch: 'abcdef12-1234-1234-1234-123456789abc' }
  expect(validActivateArgs([ref])).toBe(true)
  for (const args of [[], [ref, ref], [null], [{ ...ref, path: '/tmp/secret' }], [{ ...ref, epoch: '' }], [{ docId: ref.docId }]]) expect(validActivateArgs(args)).toBe(false)
})


test('lifecycle IPC accepts only fixed actions and latest state, never a path or force flag', () => {
  const ref = { docId: '12345678-1234-1234-1234-123456789abc', epoch: 'abcdef12-1234-1234-1234-123456789abc' }
  const snapshot = { ...ref, revision: 1, text: 'local' }
  expect(validReconcileArgs([{ ref, snapshot }])).toBe(true)
  expect(validReconcileArgs([{ ref, snapshot: null }])).toBe(true)
  for (const action of ['inspect', 'save-copy', 'use-disk', 'overwrite']) expect(validConflictArgs([ref, action, snapshot])).toBe(true)
  for (const args of [[ref, 'force', snapshot], [ref, 'overwrite', snapshot, true], [{ ...ref, path: '/tmp/a.md' }, 'overwrite', snapshot], [ref, 'overwrite', { ...snapshot, force: true }], [ref, 'inspect', null], [ref, 'inspect', { ...snapshot, revision: -1 }]]) expect(validConflictArgs(args)).toBe(false)
  expect(validReconcileArgs([{ ref, snapshot, dirty: false }])).toBe(false)
})

test('history lookup only accepts an exact owner ref and record UUID, never a path, hash or body', async () => {
  const { validHistoryArgs } = await import('../../src/main/ipc/validation')
  const ref = { docId: '12345678-1234-1234-1234-123456789abc', epoch: 'abcdef12-1234-1234-1234-123456789abc' }
  expect(validHistoryArgs([ref, ref.docId])).toBe(true)
  for (const args of [[], [ref], [ref, '../doc.md'], [ref, 'a'.repeat(64)], [ref, ref.docId, 'body'], [{ ...ref, path: '/tmp/doc.md' }, ref.docId], [{ ...ref, epoch: '' }, ref.docId], [ref, { id: ref.docId, text: 'body' }]]) expect(validHistoryArgs(args)).toBe(false)
})

test('presentation accepts one exact UUID/ref/boolean and no generic window controls', async () => {
  const { validPresentationArgs } = await import('../../src/main/ipc/validation')
  const id = '12345678-1234-1234-1234-123456789abc'; const request = { requestId: id, ref: { docId: id, epoch: id }, enabled: true }
  expect(validPresentationArgs([request])).toBe(true)
  expect(validPresentationArgs([{ ...request, enabled: false }])).toBe(true)
  for (const args of [[], [request, true], [null], [{ ...request, enabled: 1 }], [{ ...request, enabled: 'true' }], [{ ...request, requestId: 'bad' }], [{ ...request, force: true }], [{ ...request, ref: { ...request.ref, path: '/tmp/a' } }], [{ ...request, ref: { docId: id } }]]) expect(validPresentationArgs(args)).toBe(false)
})
