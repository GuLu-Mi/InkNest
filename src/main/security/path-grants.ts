import type { ResourceBlockedReason } from '../../shared/contracts'
import { realpath, stat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { sameIdentity } from '../documents/reader'

export class ResourceFailure extends Error {
  constructor(readonly reason: ResourceBlockedReason) { super(reason) }
}

export function withinRoot(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix)
}
export async function resolveImagePath(root: string, rawTarget: string): Promise<string> {
  let target: string
  try { target = decodeURIComponent(rawTarget) } catch { throw new ResourceFailure('access') }
  if (/^https?:/iu.test(target) || target.startsWith('//')) throw new ResourceFailure('remote')
  if (/\.(?:png|jpe?g|webp|gif)\s+["'][^\r\n]*["']$/iu.test(target)) throw new ResourceFailure('syntax')
  if (isAbsolute(target) || /^file:/iu.test(target) || /^[a-z]:[\\/]/iu.test(target)) throw new ResourceFailure('path')
  if (!target || [...target].some((character) => character.charCodeAt(0) < 32) || /[\\]/u.test(target) || /[?#]/u.test(rawTarget) || /^[a-z][a-z\d+.-]*:/iu.test(target)) throw new ResourceFailure('access')
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(target).toLowerCase())) throw new ResourceFailure('format')
  const candidate = resolve(root, target)
  if (!withinRoot(root, candidate)) throw new ResourceFailure('path')
  const path = await realpath(candidate)
  if (!withinRoot(root, path)) throw new ResourceFailure('path')
  return path
}
export async function openAuthorized(root: string, path: string, identity?: { dev: number; ino: number }) {
  if (!withinRoot(root, path)) throw new ResourceFailure('access')
  return openAuthorizedFile(path, identity)
}
// Main-process only: caller must already hold an exact-file grant from explicit selection.
export async function openAuthorizedFile(path: string, identity?: { dev: number; ino: number }) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new ResourceFailure('access')
  const expected = await stat(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || !sameIdentity(expected, actual) || (identity && (identity.dev !== actual.dev || identity.ino !== actual.ino)) || await realpath(path) !== path || !sameIdentity(actual, await stat(path))) throw new ResourceFailure('access')
    return { handle, stats: actual }
  } catch (error) { await handle.close(); throw error }
}
