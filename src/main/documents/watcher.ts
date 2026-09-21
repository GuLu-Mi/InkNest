import { watch, type FSWatcher } from 'node:fs'
import type { AppEvent } from '../../shared/contracts'
import { readDocument, safeError } from './reader'
import type { DocumentRegistry, DocumentSession } from './registry'

interface WatchedDirectory { watcher: FSWatcher; sessions: Set<DocumentSession>; timer?: ReturnType<typeof setTimeout> }
/** Directory subscriptions survive atomic rename; the set is the reference count. */
export class DirectoryWatcher {
  private readonly directories = new Map<string, WatchedDirectory>()
  private disposed = false
  constructor(private readonly registry: DocumentRegistry, private readonly send: (event: AppEvent) => void) {}
  sync(ownerId: number): void {
    if (this.disposed) return
    const wanted = new Map<string, Set<DocumentSession>>()
    for (const session of this.registry.list(ownerId)) {
      let refs = wanted.get(session.root)
      if (!refs) { refs = new Set(); wanted.set(session.root, refs) }
      refs.add(session)
    }
    for (const [root, entry] of this.directories) if (!wanted.has(root)) { clearTimeout(entry.timer); entry.watcher.close(); this.directories.delete(root) }
    for (const [root, sessions] of wanted) {
      const existing = this.directories.get(root)
      if (existing) { existing.sessions = sessions; continue }
      try {
        const watcher = watch(root, () => this.schedule(root))
        watcher.on('error', () => { const entry = this.directories.get(root); if (entry) { clearTimeout(entry.timer); entry.watcher.close(); this.directories.delete(root) }; for (const session of sessions) void this.check(session) })
        this.directories.set(root, { watcher, sessions })
      } catch { for (const session of sessions) void this.check(session) }
    }
  }
  private schedule(root: string): void {
    const entry = this.directories.get(root)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => { delete entry.timer; for (const session of entry.sessions) void this.check(session) }, 200)
  }
  async check(session: DocumentSession): Promise<void> {
    let diskStatus: 'current' | 'changed' | 'missing' | 'unavailable'
    try {
      const disk = await readDocument(session.path)
      diskStatus = disk.document.readOnlyReason === 'permission' && session.document.readOnlyReason === null ? 'unavailable' : disk.path !== session.path || disk.document.diskToken !== session.document.diskToken ? 'changed' : 'current'
    } catch (error) { diskStatus = safeError(error).code === 'NOT_FOUND' ? 'missing' : 'unavailable' }
    if (!this.disposed && this.registry.has(session) && (diskStatus !== 'current' || session.diskStatus && session.diskStatus !== 'current')) this.send({ type: 'external-change', ref: { docId: session.document.docId, epoch: session.document.epoch }, diskStatus })
  }
  checkAll(ownerId: number): void { this.sync(ownerId); for (const session of this.registry.list(ownerId)) void this.check(session) }
  dispose(): void { this.disposed = true; for (const entry of this.directories.values()) { clearTimeout(entry.timer); entry.watcher.close() }; this.directories.clear() }
}
