import type { PresentationRequest, ConflictAction, ContentSnapshot, HistoryRestoreRequest, CurrentState, ResourceReference, SaveRequest, SessionRef } from '../../shared/contracts'

interface Frame { url: string }
export function isTrustedCaller(event: { sender: unknown; senderFrame: Frame | null }, owner: { mainFrame: Frame }, developmentUrl?: string): boolean {
  if (event.sender !== owner || event.senderFrame !== owner.mainFrame) return false
  try {
    const url = new URL(owner.mainFrame.url)
    if (url.username || url.password) return false
    if (developmentUrl) return url.origin === new URL(developmentUrl).origin
    return url.protocol === 'inknest:' && url.hostname === 'app' && !url.port && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
export function validResourceArgs(args: unknown[]): args is [SessionRef, ResourceReference[]] {
  if (args.length !== 2) return false
  const [ref, refs] = args
  if (!exact(ref, ['docId', 'epoch']) || typeof ref.docId !== 'string' || typeof ref.epoch !== 'string' || !UUID.test(ref.docId) || !UUID.test(ref.epoch)) return false
  if (!Array.isArray(refs) || refs.length > 200) return false
  return refs.every((item) => exact(item, ['key', 'rawTarget']) && typeof item.key === 'string' && item.key.length > 0 && item.key.length <= 128 && typeof item.rawTarget === 'string' && item.rawTarget.length > 0 && item.rawTarget.length <= 4096)
}

export function validCloseArgs(args: unknown[]): args is [string, CurrentState] {
  if (args.length !== 2 || typeof args[0] !== 'string' || !UUID.test(args[0])) return false
  const state = args[1]
  if (!exact(state, ['ref', 'snapshot']) || !validResourceArgs([state.ref, []])) return false
  const snapshot = state.snapshot
  return snapshot === null || (exact(snapshot, ['docId', 'epoch', 'revision', 'text']) && typeof snapshot.docId === 'string' && UUID.test(snapshot.docId) && typeof snapshot.epoch === 'string' && UUID.test(snapshot.epoch) && Number.isSafeInteger(snapshot.revision) && (snapshot.revision as number) >= 0 && typeof snapshot.text === 'string' && snapshot.text.length <= 2 * 1024 * 1024)
}

export function validSaveArgs(args: unknown[]): args is [SaveRequest] {
  if (args.length !== 1) return false
  const request = args[0]
  if (!exact(request, ['requestId', 'snapshot', 'expectedDiskToken', 'trigger']) || typeof request.requestId !== 'string' || !UUID.test(request.requestId)) return false
  if (request.expectedDiskToken !== null && (typeof request.expectedDiskToken !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedDiskToken))) return false
  if (request.trigger !== 'manual' && request.trigger !== 'auto' && request.trigger !== 'close') return false
  const snapshot = request.snapshot
  if (!exact(snapshot, ['docId', 'epoch', 'revision', 'text'])) return false
  return validCloseArgs([request.requestId, { ref: { docId: snapshot.docId, epoch: snapshot.epoch }, snapshot }])
}

export function validActivateArgs(args: unknown[]): args is [SessionRef] {
  return args.length === 1 && validResourceArgs([args[0], []])
}

export function validReconcileArgs(args: unknown[]): args is [CurrentState] {
  return args.length === 1 && validCloseArgs(['00000000-0000-0000-0000-000000000000', args[0]])
}
export function validConflictArgs(args: unknown[]): args is [SessionRef, ConflictAction, ContentSnapshot] {
  return args.length === 3 && ['inspect', 'save-copy', 'use-disk', 'overwrite'].includes(args[1] as string) && args[2] !== null && validReconcileArgs([{ ref: args[0], snapshot: args[2] }])
}

export function validCheckpointArgs(args: unknown[]): args is [ContentSnapshot] {
  if (args.length !== 1 || !exact(args[0], ['docId', 'epoch', 'revision', 'text'])) return false
  return validReconcileArgs([{ ref: { docId: args[0].docId, epoch: args[0].epoch }, snapshot: args[0] }])
}
export function validRecordIdArgs(args: unknown[]): args is [string] { return args.length === 1 && typeof args[0] === 'string' && UUID.test(args[0]) }
export function validHistoryArgs(args: unknown[]): args is [SessionRef, string] { return args.length === 2 && validActivateArgs([args[0]]) && validRecordIdArgs([args[1]]) }

export function validHistoryRestoreArgs(args: unknown[]): args is [HistoryRestoreRequest] {
  if (args.length !== 1) return false
  const request = args[0]
  return exact(request, ['requestId', 'snapshot', 'expectedDiskToken', 'historyId', 'expectedContentHash']) &&
    validSaveArgs([{ requestId: request.requestId, snapshot: request.snapshot, expectedDiskToken: request.expectedDiskToken, trigger: 'manual' }]) &&
    validRecordIdArgs([request.historyId]) && typeof request.expectedContentHash === 'string' && /^[a-f0-9]{64}$/u.test(request.expectedContentHash)
}

export function validPresentationArgs(args: unknown[]): args is [PresentationRequest] {
  if (args.length !== 1) return false
  const request = args[0]
  return exact(request, ['requestId', 'ref', 'enabled']) && validRecordIdArgs([request.requestId]) && validActivateArgs([request.ref]) && typeof request.enabled === 'boolean'
}

export function validLinkArgs(args: unknown[]): args is [import('../../shared/contracts').LinkRequest] {
  if (args.length !== 1 || !exact(args[0], ['requestId', 'ref', 'rawTarget'])) return false
  const request = args[0]
  return typeof request.requestId === 'string' && UUID.test(request.requestId) && validActivateArgs([request.ref]) && typeof request.rawTarget === 'string' && request.rawTarget.length > 0 && request.rawTarget.length <= 4096
}
