import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface WrittenIdentity { dev: number; ino: number }
export type AtomicWriter = (path: string, bytes: Uint8Array, check: () => Promise<void>) => Promise<WrittenIdentity>
/** Library owns staging, file fsync and rename; caller owns conflicts and serialization. */
export const atomicWrite: AtomicWriter = async (path, bytes, check) => {
  await check()
  let identity: WrittenIdentity | undefined
  await writeFileAtomic(path, Buffer.from(bytes), { fsync: true, tmpfileCreated: async (temporaryPath) => {
    const staged = await stat(temporaryPath)
    identity = { dev: staged.dev, ino: staged.ino }
    await check()
  } })
  // POSIX directory sync strengthens rename durability; Windows cannot open directories this way.
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  if (!identity) throw new Error('Atomic replacement identity unavailable')
  return identity
}
