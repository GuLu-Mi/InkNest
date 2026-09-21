import { copy } from '../../shared/copy'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import type { AppError, OpenDocument } from '../../shared/contracts'
import { classifyDocumentSize, LOADABLE_DOCUMENT_MAX_BYTES } from '../../shared/limits'
import { decodeUtf8 } from './codec'

export class FileFailure extends Error {
  constructor(readonly appError: AppError) { super(appError.message) }
}
export function fail(code: AppError['code'], message: string): never {
  throw new FileFailure({ code, message, retryable: false })
}
export function safeError(error: unknown): AppError {
  if (error instanceof FileFailure) return error.appError
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return { code: 'NOT_FOUND', message: copy.fileMissing, retryable: true }
  if (code === 'EACCES' || code === 'EPERM') return { code: 'ACCESS_DENIED', message: copy.readDenied, retryable: true }
  return { code: 'IO_ERROR', message: copy.readFailed, retryable: true }
}
export function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino }
export function sameVersion(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
export async function readBounded(handle: FileHandle, size: number, max: number): Promise<Buffer> {
  if (size > max) fail('TOO_LARGE', copy.fileTooLarge)
  const bytes = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (!result.bytesRead) break
    offset += result.bytesRead
  }
  if (offset > max) fail('TOO_LARGE', copy.fileTooLarge)
  if (offset !== size) fail('IO_ERROR', copy.changedDuringRead)
  return bytes.subarray(0, offset)
}
export interface Candidate {
  rawBytes: Buffer
  path: string
  root: string
  fingerprint: { sha256: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
  document: Omit<OpenDocument, 'docId' | 'epoch'>
}
export async function readDocument(selectedPath: string, expected?: { path: string; dev: number; ino: number }): Promise<Candidate> {
  if (!['.md', '.markdown'].includes(extname(selectedPath).toLowerCase())) fail('UNSUPPORTED_TYPE', copy.unsupportedFile)
  const path = await realpath(selectedPath)
  if (expected && path !== expected.path) fail('ACCESS_DENIED', '链接目标已变化，请重新打开')
  const entry = await lstat(selectedPath)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (expected && (before.dev !== expected.dev || before.ino !== expected.ino)) fail('ACCESS_DENIED', '链接目标已变化，请重新打开')
    if (!before.isFile()) fail('UNSUPPORTED_TYPE', copy.regularMarkdownOnly)
    const sizeClass = classifyDocumentSize(before.size)
    if (sizeClass === 'reject') fail('TOO_LARGE', copy.loadLimit)
    if (!sameIdentity(before, await stat(path))) fail('IO_ERROR', copy.changedDuringRead)
    const bytes = await readBounded(handle, before.size, LOADABLE_DOCUMENT_MAX_BYTES)
    const after = await handle.stat()
    if (after.size > LOADABLE_DOCUMENT_MAX_BYTES) fail('TOO_LARGE', copy.loadLimitShort)
    if (!sameVersion(before, after) || await realpath(selectedPath) !== path || !sameVersion(after, await stat(path))) fail('IO_ERROR', copy.changedDuringRead)
    const decoded = decodeUtf8(bytes)
    let reason: OpenDocument['readOnlyReason'] = decoded.kind === 'readonly' ? decoded.reason : null
    if (entry.isSymbolicLink() || before.nlink > 1) reason = 'link'
    try { await access(path, constants.W_OK) } catch { reason = 'permission' }
    if (sizeClass === 'readonly') reason = 'size'
    const fingerprint = { sha256: createHash('sha256').update(bytes).digest('hex'), dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs }
    const format = decoded.kind === 'editable' ? decoded.format : null
    // Metadata detects a read race, but cannot establish an authoritative content conflict.
    const diskToken = createHash('sha256').update(JSON.stringify({
      sha256: fingerprint.sha256, dev: fingerprint.dev, ino: fingerprint.ino, format
    })).digest('hex')
    return { rawBytes: bytes, path, root: dirname(path), fingerprint, document: {
      displayName: basename(selectedPath), displayPath: selectedPath, text: decoded.text,
      revision: 0, format, diskToken, readOnlyReason: reason, recovered: false, readingPosition: null
    } }
  } finally { await handle.close() }
}
