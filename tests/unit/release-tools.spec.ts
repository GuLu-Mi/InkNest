import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { createPackage, uncache } from '@electron/asar'

import { createSmokeBundle } from '../../scripts/create-smoke-bundle.mjs'
import { inspectExecutableArchitecture, inspectPreloadChannels, inspectPackages, inspectProcessBoundary, listAsarEntries, textFromAsar } from '../../scripts/package-inspection.mjs'

describe('ASAR inspection on the native build host', () => {
  it('reads nested entries and lists dependency paths consistently across platforms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-asar-'))
    const source = join(root, 'source')
    const archive = join(root, 'sample.asar')
    try {
      await mkdir(join(source, 'out', 'main'), { recursive: true })
      await mkdir(join(source, 'node_modules', 'write-file-atomic'), { recursive: true })
      await writeFile(join(source, 'out', 'main', 'index.js'), '// 固定样本，不执行\n')
      await writeFile(join(source, 'node_modules', 'write-file-atomic', 'package.json'), '{"name":"write-file-atomic"}')
      await createPackage(source, archive)

      expect(textFromAsar(archive, 'out/main/index.js')).toBe('// 固定样本，不执行\n')
      expect(JSON.parse(textFromAsar(archive, 'node_modules/write-file-atomic/package.json'))).toEqual({ name: 'write-file-atomic' })
      expect(listAsarEntries(archive)).toEqual([
        'node_modules', 'node_modules/write-file-atomic', 'node_modules/write-file-atomic/package.json',
        'out', 'out/main', 'out/main/index.js'
      ])
    } finally {
      uncache(archive)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('native smoke fixture bundle', () => {
  it('creates a deterministic Windows-friendly archive with the required isolated cases', async () => {
    const first = await mkdtemp(join(tmpdir(), 'inknest-smoke-a-'))
    const second = await mkdtemp(join(tmpdir(), 'inknest-smoke-b-'))

    try {
      const firstResult = await createSmokeBundle(first, '1.2.3')
      const secondResult = await createSmokeBundle(second, '1.2.3')

      expect(firstResult.root).toContain('InkNest-1.2.3-smoke-fixtures')
      expect(await readFile(join(firstResult.root, 'README.txt'), 'utf8')).toContain('InkNest 1.2.3')
      await expect(createSmokeBundle(first, '1.2.3')).rejects.toThrow('already exists')
      expect(firstResult.archiveSha256).toBe(secondResult.archiveSha256)
      const archiveHeader = await readFile(firstResult.archive)
      expect(archiveHeader.readUInt16LE(6) & 0x0800).toBe(0x0800)
      expect((await stat(join(firstResult.root, 'performance', 'standard-100KiB.md'))).size).toBe(100 * 1024)
      expect((await stat(join(firstResult.root, 'limits', 'readonly-2MiB-plus-1.md'))).size).toBe(2 * 1024 * 1024 + 1)
      expect(await readFile(join(firstResult.root, 'docs', '中文 说明.md'), 'utf8')).toContain('![同目录 PNG](<图像%20%23100%25.png>)')
      expect(await readFile(join(firstResult.root, 'docs', '中文 说明.md'), 'utf8')).toContain('![越界 PNG](<../外部-不应加载.png>)')
      const png = await readFile(join(firstResult.root, 'docs', '图像 #100%.png'))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 64])

      const manifest = JSON.parse(await readFile(firstResult.manifest, 'utf8')) as {
        files: Array<{ path: string; sha256: string; bytes: number }>
      }
      expect(manifest.files).toHaveLength(14)
      expect(manifest.files.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        'docs/中文 说明.md',
        'docs/图像 #100%.png',
        'encoding/invalid-utf8.md',
        'encoding/mixed-eol.md',
        'encoding/utf8-bom-crlf-no-final.md',
        'limits/readonly-2MiB-plus-1.md',
        'performance/standard-100KiB.md',
        'README.txt',
        '外部-不应加载.png',
        'tabs/甲/同名.md',
        'tabs/乙/同名.md',
        'tabs/很长的中文 文档名称用于标签截断与路径提示检查.md',
        'docs/reader-layout.md'
      ]))
      expect(manifest.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0)).toBe(true)
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true })
      ])
    }
  })
})

describe('packaged executable architecture inspection', () => {
  it('identifies arm64 Mach-O and x64 PE executables from their headers', () => {
    const mach = Buffer.alloc(32)
    mach.writeUInt32LE(0xfeedfacf, 0)
    mach.writeUInt32LE(0x0100000c, 4)

    const pe = Buffer.alloc(256)
    pe.write('MZ', 0, 'ascii')
    pe.writeUInt32LE(128, 0x3c)
    pe.write('PE\0\0', 128, 'ascii')
    pe.writeUInt16LE(0x8664, 132)

    expect(inspectExecutableArchitecture(mach)).toEqual({ format: 'Mach-O', architecture: 'arm64' })
    expect(inspectExecutableArchitecture(pe)).toEqual({ format: 'PE', architecture: 'x64' })
  })

  it('rejects unknown or truncated executable headers', () => {
    expect(() => inspectExecutableArchitecture(Buffer.from('not executable'))).toThrow('Unsupported executable format')
    expect(() => inspectExecutableArchitecture(Buffer.from('MZ'))).toThrow('Truncated PE executable')
  })
})

describe('release package contract', () => {
  it('requires an independently supplied expected version', async () => {
    await expect(inspectPackages({ macApp: '/missing' })).rejects.toThrow('expected version')
  })
  it('rejects extra and dynamic preload capabilities including non-document channels', () => {
    const approved = ['backup:checkpoint', 'backup:clear', 'backup:discard-recovery', 'backup:export-history', 'backup:inspect-history', 'backup:inspect-recovery', 'backup:list-history', 'backup:list-recovery', 'backup:restore-history', 'backup:restore-recovery', 'document:activate', 'document:close', 'document:complete-close', 'document:conflict', 'document:event', 'document:link', 'document:open', 'document:reconcile', 'document:renderer-ready', 'document:resources', 'document:save', 'document:save-as', 'settings:set-theme', 'settings:theme', 'window:presentation']
    const preload = approved.map(channel => `ipcRenderer.${channel === 'document:event' ? 'on' : 'invoke'}("${channel}", value)`).join('\n')
    expect(inspectPreloadChannels(preload)).toEqual(approved)
    expect(() => inspectPreloadChannels(`${preload}\nipcRenderer.invoke("arbitrary:read", path)`)).toThrow('unexpected preload IPC')
    expect(() => inspectPreloadChannels(`${preload}\nipcRenderer.invoke(channel, value)`)).toThrow('dynamic preload IPC')
    expect(() => inspectPreloadChannels(preload.replace('ipcRenderer.invoke("window:presentation", value)', ''))).toThrow('unexpected preload IPC')
    expect(() => inspectPreloadChannels(preload.replace('document:save-as', 'document:force'))).toThrow('unexpected preload IPC')
  })
})


describe('packaged link process boundary', () => {
  it('accepts validated main routing but rejects preload shell access and unguarded main dispatch', () => {
    const routed = 'new LinkRouter(); validLinkArgs(args); isTrustedCaller(event, window.webContents); ipcMain.handle("document:link"); shell.openExternal(url)'
    expect(() => inspectProcessBoundary(routed, 'ipcRenderer.invoke("document:link", request)')).not.toThrow()
    expect(() => inspectProcessBoundary(routed, 'shell.openPath(path)')).toThrow('preload exposes')
    expect(() => inspectProcessBoundary('shell.openExternal(url)', '')).toThrow('missing controlled')
    expect(() => inspectProcessBoundary(routed + '; child_process.exec(cmd)', '')).toThrow('process execution')
  })
})
