import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import type { ThemePreferences, ThemeChoice } from '../shared/contracts'

export class ThemeStore {
  current: ThemePreferences = { theme: 'system', warning: '' }
  private queue: Promise<unknown> = Promise.resolve()
  private sequence = 0
  private damaged = false
  constructor(private readonly path: string) {}
  async load(): Promise<ThemePreferences> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('theme' in value) || typeof value.theme !== 'string' || !['light', 'dark', 'system'].includes(value.theme)) throw new Error('invalid preferences')
      this.current = { theme: value.theme as ThemeChoice, warning: '' }
    } catch (error) {
      this.damaged = (error as NodeJS.ErrnoException).code !== 'ENOENT'
      this.current = { theme: 'system', warning: this.damaged ? '主题偏好无法读取，已跟随系统。' : '' }
    }
    return this.current
  }
  set(theme: 'light' | 'dark'): Promise<ThemePreferences> {
    const sequence = ++this.sequence
    this.current = { theme, warning: '' }
    const operation = this.queue.then(async () => {
      let warning = ''
      try {
        if (this.damaged) { await copyFile(this.path, `${this.path}.damaged-${randomUUID()}`, constants.COPYFILE_EXCL); this.damaged = false }
        await writeFileAtomic(this.path, JSON.stringify({ version: 1, theme }), { fsync: true, mode: 0o600 })
      }
      catch { warning = '主题本次已生效，下次可能无法保留。请再次选择以重试。' }
      const result = { theme, warning }
      if (sequence === this.sequence) this.current = result
      return result
    })
    this.queue = operation
    return operation
  }
}
