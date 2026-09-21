import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeStore } from '../../src/main/theme-store'

describe('theme preferences', () => {
  it('defaults to system, serializes rapid selections and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-theme-'))
    try {
      const path = join(root, 'theme.json'); const store = new ThemeStore(path)
      expect(await store.load()).toEqual({ theme: 'system', warning: '' })
      await Promise.all([store.set('dark'), store.set('light'), store.set('dark')])
      expect((await new ThemeStore(path).load()).theme).toBe('dark')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, theme: 'dark' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each([['dark'], { toString: 'dark' }, 1, null])('rejects malformed theme values: %j', async theme => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-theme-schema-'))
    try {
      const path = join(root, 'theme.json'); await writeFile(path, JSON.stringify({ version: 1, theme }))
      const result = await new ThemeStore(path).load()
      expect(result.theme).toBe('system'); expect(result.warning).not.toBe('')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('reports damaged preferences and keeps an unsaved choice effective for this session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-theme-bad-'))
    try {
      const path = join(root, 'theme.json'); await writeFile(path, '{broken')
      const damagedStore = new ThemeStore(path); const damaged = await damagedStore.load()
      expect(damaged.theme).toBe('system'); expect(damaged.warning).not.toBe('')
      await damagedStore.set('light')
      const copy = (await readdir(root)).find(name => name.startsWith('theme.json.damaged-'))!
      expect(await readFile(join(root, copy), 'utf8')).toBe('{broken')
      const store = new ThemeStore(join(root, 'missing', 'theme.json'))
      const failed = await store.set('dark')
      expect(failed.theme).toBe('dark'); expect(failed.warning).toContain('下次可能无法保留')
      expect(store.current.theme).toBe('dark')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
