import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, readReleaseConfig } from './release-config.mjs'

function check(ok, message) { if (!ok) throw new Error(message) }

export function githubApi(repo, token) {
  check(/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '') && token, 'GitHub repository and token are required')
  return async (path, { method = 'GET', body, optional = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (optional && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
}

export async function readReleaseState(api, tag) {
  const ref = await api(`git/ref/tags/${tag}`, { optional: true })
  const tagCommit = ref ? (await api(`commits/${tag}`)).sha : null
  let release = await api(`releases/tags/${tag}`, { optional: true })
  // The tag endpoint omits drafts; authenticated release listings include them.
  for (let page = 1; !release; page++) {
    const releases = await api(`releases?per_page=100&page=${page}`)
    release = releases.find(item => item.tag_name === tag) ?? null
    if (releases.length < 100) break
  }
  return { tagCommit, release }
}

export function assertReleaseAvailable({ tagCommit, release }, tag, sha) {
  check(!release || release.draft, `${tag} is already published. Bump the version before publishing again.`)
  check(!tagCommit || tagCommit === sha, `${tag} belongs to a different commit; it will not be moved.`)
  // An existing tag is authoritative; GitHub may retain a branch name in target_commitish.
  check(!release || tagCommit === sha || release.target_commitish === sha, 'Existing release draft belongs to a different commit.')
}

export async function prepareAssets(directory, config) {
  const names = (await readdir(directory)).sort()
  check(JSON.stringify(names) === JSON.stringify([...config.installers].sort()), 'Expected exactly the Windows and macOS installers from this build')
  const assets = []
  for (const name of config.installers) {
    const bytes = await readFile(join(directory, name))
    check(bytes.length > 0, `Empty installer: ${name}`)
    assets.push({ name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
  }
  const sums = assets.map(asset => `${asset.digest.slice(7)}  ${asset.name}\n`).join('')
  await writeFile(join(directory, 'SHA256SUMS.txt'), sums)
  assets.push({ name: 'SHA256SUMS.txt', size: Buffer.byteLength(sums), digest: `sha256:${createHash('sha256').update(sums).digest('hex')}` })
  return assets
}

export function verifyUploadedAssets(uploaded, expected, complete = false) {
  check(!complete || uploaded.length === expected.length, 'Release attachments are incomplete')
  check(new Set(uploaded.map(asset => asset.name)).size === uploaded.length, 'Duplicate release attachment')
  for (const asset of uploaded) {
    const match = expected.find(item => item.name === asset.name)
    check(match && asset.state === 'uploaded' && asset.size === match.size && asset.digest === match.digest,
      `Release attachment differs from this build: ${asset.name}`)
  }
}

export function releaseNotes(config, changelog, repo, previousTag) {
  const sections = changelog.split(/^## /mu).slice(1)
  const section = sections.find(text => text.split('\n')[0].trim() === config.version)
  const changes = section?.slice(section.indexOf('\n') + 1).trim()
  const compare = previousTag && previousTag !== config.tag
    ? `\n[查看代码变化](https://github.com/${repo}/compare/${encodeURIComponent(previousTag)}...${config.tag})\n` : ''
  return `InkNest ${config.version}\n\n${changes || '本版本的功能与使用方式见项目 README。'}\n${compare}
## 下载

| 平台 | 安装包 |
| --- | --- |
| Windows 11 x64 | \`${config.installers[0]}\` |
| macOS 14 及以上 Apple Silicon | \`${config.installers[1]}\` |

在 Assets 下载对应安装包；Source code 为源码。SHA256SUMS.txt 提供安装包校验值。

## 使用限制

Windows 安装包未签名；macOS 使用 ad-hoc 签名，尚无 Developer ID 签名与公证。目标系统的完整安装与运行兼容性尚未经完整验证，详见[已知限制](https://github.com/${repo}/blob/${config.tag}/docs/known-issues.md)。\n`
}

export async function publishRelease({ api, upload, config, sha, notes, assets }) {
  // Recheck after both builds: main or remote release state may have changed.
  const state = await readReleaseState(api, config.tag)
  assertReleaseAvailable(state, config.tag, sha)
  if (state.release) verifyUploadedAssets(state.release.assets, assets)
  if (!state.tagCommit) await api('git/refs', { method: 'POST', body: { ref: `refs/tags/${config.tag}`, sha } })
  const release = state.release ?? await api('releases', {
    method: 'POST', body: { tag_name: config.tag, target_commitish: sha, name: `InkNest ${config.version}`, body: notes, draft: true, prerelease: false }
  })
  const present = new Set(release.assets.map(asset => asset.name))
  for (const asset of assets) if (!present.has(asset.name)) await upload(asset.name)
  const current = await api(`releases/${release.id}`)
  check(current.draft && current.tag_name === config.tag, 'Release changed during upload')
  verifyUploadedAssets(current.assets, assets, true)
  check((await api(`commits/${config.tag}`)).sha === sha, 'Release tag changed during upload')
  return api(`releases/${release.id}`, { method: 'PATCH', body: { body: notes, draft: false, make_latest: 'true' } })
}

async function main() {
  const { GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, RELEASE_PUBLISH: publish } = process.env
  check(ref === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Run Release manually on main')
  check(/^[a-f0-9]{40}$/u.test(sha ?? '') && ['true', 'false'].includes(publish), 'Invalid release context')
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === sha, 'Checkout differs from the selected main commit')
  const config = await readReleaseConfig()
  const command = process.argv[2]
  if (command === 'prepare') {
    if (publish === 'true') {
      const api = githubApi(repo, process.env.GH_TOKEN)
      assertReleaseAvailable(await readReleaseState(api, config.tag), config.tag, sha)
    }
    await appendFile(process.env.GITHUB_OUTPUT, `version=${config.version}\ntag=${config.tag}\n`)
    console.log(`Version ${config.version}; commit ${sha}; publish ${publish}`)
  } else if (command === 'finish') {
    const directory = resolve(process.argv[3])
    const assets = await prepareAssets(directory, config)
    const api = githubApi(repo, process.env.GH_TOKEN)
    const latest = await api('releases/latest', { optional: true })
    const notes = releaseNotes(config, await readFile(join(projectRoot, 'CHANGELOG.md'), 'utf8'), repo, latest?.tag_name)
    await writeFile(join(projectRoot, '.tooling', 'release-preview.md'), notes)
    if (publish === 'true') {
      const release = await publishRelease({ api, config, sha, notes, assets, upload: name => {
        execFileSync('gh', ['release', 'upload', config.tag, join(directory, name), '--repo', repo], { stdio: 'inherit' })
      } })
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `Published [${config.tag}](${release.html_url}) from \`${sha}\`.\n`)
      console.log(release.html_url)
    } else {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `Build and release preview verified for ${config.tag}. No tag or Release was created or modified.\n\n${notes}`)
      console.log('Build and publication preview verified; no remote writes.')
    }
  } else throw new Error('Use prepare or finish')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
