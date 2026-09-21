import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readReleaseConfig, releaseConfig } from '../../scripts/release-config.mjs'
import { assertReleaseAvailable, prepareAssets, publishRelease, releaseNotes, verifyUploadedAssets } from '../../scripts/github-release.mjs'

const sha = 'a'.repeat(40)
const config = releaseConfig('1.2.3')
const assets = config.installers.map(name => ({ name, size: 10, digest: `sha256:${'b'.repeat(64)}` }))
assets.push({ name: 'SHA256SUMS.txt', size: 20, digest: `sha256:${'c'.repeat(64)}` })
type Asset = (typeof assets)[number] & { state: string }
type Release = { id: number; draft: boolean; target_commitish: string; tag_name: string; assets: Asset[] }

function remote(options: { published?: boolean; tagCommit?: string; draft?: Release; uploadFailure?: boolean; movedTag?: boolean } = {}) {
  let tagCommit: string | null = options.tagCommit ?? null
  let release: Release | null = options.draft ?? (options.published
    ? { id: 1, draft: false, target_commitish: sha, tag_name: config.tag, assets: [] } : null)
  const writes: string[] = []
  const uploads: string[] = []
  const api = async (path: string, request: { method?: string; body?: Record<string, unknown> } = {}) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET') writes.push(`${method} ${path}`)
    if (path.startsWith('git/ref/tags/')) return tagCommit ? { object: { sha: tagCommit } } : null
    if (path.startsWith('commits/')) return { sha: options.movedTag && uploads.length > 0 ? 'd'.repeat(40) : tagCommit }
    if (path.startsWith('releases/tags/')) return release && !release.draft ? release : null
    if (path.startsWith('releases?')) return release ? [release] : []
    if (path === 'git/refs' && method === 'POST') { tagCommit = request.body?.sha as string; return { object: { sha: tagCommit } } }
    if (path === 'releases' && method === 'POST') {
      release = { id: 1, draft: true, target_commitish: request.body?.target_commitish as string, tag_name: config.tag, assets: [] }
      return release
    }
    if (path === 'releases/1' && release) {
      if (method === 'PATCH') release.draft = request.body?.draft as boolean
      return release
    }
    throw new Error(`Unexpected API call ${method} ${path}`)
  }
  const upload = async (name: string) => {
    if (options.uploadFailure) throw new Error('Upload interrupted')
    uploads.push(name)
    release?.assets.push({ ...assets.find(asset => asset.name === name)!, state: 'uploaded' })
  }
  return { api, upload, writes, uploads, getRelease: () => release }
}

describe('version and build configuration', () => {
  it('updates package and lock once through the documented command without altering dependency versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-version-'))
    try {
      const actualPackage = JSON.parse(await readFile('package.json', 'utf8'))
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'version-test', version: '1.2.3', scripts: { 'version:set': actualPackage.scripts['version:set'] } }))
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'version-test', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'version-test', version: '1.2.3' }, 'node_modules/sample': { version: '0.1.0' } } }))
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'version:set', '--', '1.2.4'], { cwd: root, shell: process.platform === 'win32', stdio: 'pipe' })
      const next = await readReleaseConfig(root)
      expect(next).toMatchObject({ version: '1.2.4', tag: 'v1.2.4', directory: join(root, 'release', '1.2.4'), fixtureName: 'InkNest-1.2.4-smoke-fixtures' })
      expect(next.installers).toEqual(['InkNest-1.2.4-win-x64.exe', 'InkNest-1.2.4-mac-arm64.dmg'])
      expect(next.macApp).toContain(join('mac-builds', '1.2.4', 'mac-arm64', 'InkNest.app'))
      const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
      expect(lock.packages['node_modules/sample'].version).toBe('0.1.0')
      expect(await readdir(root)).not.toContain('.git')
      lock.version = '1.2.3'
      await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
      await expect(readReleaseConfig(root)).rejects.toThrow('versions differ')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['../1.2.3', '01.2.3', '1.2', '1.2.3-beta.1', '1.2.3\n', 'v1.2.3'])('rejects unsupported release version %s', version => {
    expect(() => releaseConfig(version)).toThrow('stable version')
  })
  it('rejects a lock root package that differs even if the lock top-level version matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-lock-'))
    try {
      await writeFile(join(root, 'package.json'), '{"version":"1.2.3"}')
      await writeFile(join(root, 'package-lock.json'), '{"version":"1.2.3","packages":{"":{"version":"1.2.2"}}}')
      await expect(readReleaseConfig(root)).rejects.toThrow('versions differ')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('release attachments and notes', () => {
  it('requires both installers, rejects unrelated files, and hashes the actual bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inknest-assets-'))
    try {
      await writeFile(join(root, config.installers[0]), 'windows')
      await expect(prepareAssets(root, config)).rejects.toThrow('exactly')
      await writeFile(join(root, config.installers[1]), '')
      await expect(prepareAssets(root, config)).rejects.toThrow('Empty installer')
      await writeFile(join(root, config.installers[1]), 'macos')
      await writeFile(join(root, 'unexpected.txt'), 'extra')
      await expect(prepareAssets(root, config)).rejects.toThrow('exactly')
      await rm(join(root, 'unexpected.txt'))
      const result = await prepareAssets(root, config)
      expect(result).toHaveLength(3)
      expect(result[0].size).toBe(7)
      expect(await readFile(join(root, 'SHA256SUMS.txt'), 'utf8')).toContain(`${result[0].digest.slice(7)}  ${config.installers[0]}`)
      expect(() => verifyUploadedAssets(result.map(asset => ({ ...asset, state: 'uploaded' })), result, true)).not.toThrow()
      expect(() => verifyUploadedAssets([{ ...result[0], state: 'uploaded', digest: 'sha256:wrong' }], result)).toThrow('differs')
      expect(() => verifyUploadedAssets([], result, true)).toThrow('incomplete')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('uses only the requested changelog section and provides a fallback and comparison link', () => {
    const notes = releaseNotes(config, '# Changes\n\n## 1.2.3\n\n- 修复搜索\n\n## 1.2.2\n\n- 旧内容\n', 'owner/repo', 'v1.2.2')
    expect(notes).toContain('修复搜索')
    expect(notes).not.toContain('旧内容')
    expect(notes).toContain('/compare/v1.2.2...v1.2.3')
    expect(notes).toContain(config.installers[0])
    expect(releaseNotes(config, '# Changes', 'owner/repo')).toContain('README')
  })
  it('keeps changelog document links usable on a Release page at the released version', () => {
    const notes = releaseNotes(config, '# Changes\n\n## 1.2.3\n\n[限制](docs/known-issues.md) [功能](#features) [GitHub](https://github.com)', 'owner/repo')
    expect(notes).toContain('[限制](https://github.com/owner/repo/blob/v1.2.3/docs/known-issues.md)')
    expect(notes).toContain('[功能](https://github.com/owner/repo/blob/v1.2.3/CHANGELOG.md#features)')
    expect(notes).toContain('[GitHub](https://github.com)')
    expect(releaseNotes(config, '# Changes', 'owner/repo')).toContain('[README](https://github.com/owner/repo/blob/v1.2.3/README.md)')
  })
})

describe('release publication safeguards', () => {
  it('creates the tag at the built commit, uploads everything, then publishes', async () => {
    const server = remote()
    const result = await publishRelease({ ...server, config, sha, notes: 'Notes', assets })
    expect(result.draft).toBe(false)
    expect(server.writes).toEqual(['POST git/refs', 'POST releases', 'PATCH releases/1'])
    expect(server.uploads).toEqual(assets.map(asset => asset.name))
    expect(server.getRelease()?.target_commitish).toBe(sha)
  })
  it('refuses an already published version without any writes', async () => {
    const server = remote({ published: true })
    await expect(publishRelease({ ...server, config, sha, notes: '', assets })).rejects.toThrow('already published')
    expect(server.writes).toEqual([])
  })
  it('does not move an existing tag or reuse an unrelated draft', async () => {
    const server = remote({ tagCommit: 'd'.repeat(40) })
    await expect(publishRelease({ ...server, config, sha, notes: '', assets })).rejects.toThrow('different commit')
    expect(server.writes).toEqual([])
    expect(() => assertReleaseAvailable({ tagCommit: null, release: { draft: true, target_commitish: 'main' } }, config.tag, sha)).toThrow('different commit')
    expect(() => assertReleaseAvailable({ tagCommit: sha, release: { draft: true, target_commitish: 'main' } }, config.tag, sha)).not.toThrow()
  })
  it('leaves a draft unpublished if an upload fails', async () => {
    const server = remote({ uploadFailure: true })
    await expect(publishRelease({ ...server, config, sha, notes: '', assets })).rejects.toThrow('Upload interrupted')
    expect(server.getRelease()?.draft).toBe(true)
    expect(server.writes).not.toContain('PATCH releases/1')
  })
  it('keeps the draft private when uploaded bytes fail the final checksum check', async () => {
    const server = remote()
    const upload = async (name: string) => {
      await server.upload(name)
      server.getRelease()!.assets.at(-1)!.digest = 'sha256:corrupted'
    }
    await expect(publishRelease({ ...server, upload, config, sha, notes: '', assets })).rejects.toThrow('differs')
    expect(server.getRelease()?.draft).toBe(true)
    expect(server.writes).not.toContain('PATCH releases/1')
  })
  it('resumes the same draft, keeping already verified assets', async () => {
    const server = remote({ tagCommit: sha, draft: { id: 1, draft: true, tag_name: config.tag, target_commitish: sha, assets: [{ ...assets[0]!, state: 'uploaded' }] } })
    await publishRelease({ ...server, config, sha, notes: '', assets })
    expect(server.uploads).toEqual(assets.slice(1).map(asset => asset.name))
    expect(server.writes).toEqual(['PATCH releases/1'])
  })
  it('refuses mismatching existing attachments without overwriting them', async () => {
    const server = remote({ tagCommit: sha, draft: { id: 1, draft: true, tag_name: config.tag, target_commitish: sha, assets: [{ ...assets[0]!, size: 99, state: 'uploaded' }] } })
    await expect(publishRelease({ ...server, config, sha, notes: '', assets })).rejects.toThrow('differs')
    expect(server.writes).toEqual([])
    expect(server.uploads).toEqual([])
  })
  it('does not publish if someone moves the tag while assets are uploading', async () => {
    const server = remote({ movedTag: true })
    await expect(publishRelease({ ...server, config, sha, notes: '', assets })).rejects.toThrow('tag changed')
    expect(server.getRelease()?.draft).toBe(true)
    expect(server.writes).not.toContain('PATCH releases/1')
  })
})
