// Exercise real LaunchServices events against a built app using isolated documents/profile.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtemp, writeFile, readFile, mkdir, realpath } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import { unregisterMacBuild } from './macos-app-registration.mjs'

if (process.platform !== 'darwin') throw new Error('macOS only')
const appPath = resolve(process.argv[2])
const output = resolve(process.argv[3])
await mkdir(output, { recursive: true })
const run = promisify(execFile)
const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-launchservices-')))
const a = join(root, '系统 冷启动 #100%.MD'), b = join(root, '后台 打开.markdown')
await writeFile(a, '# 冷启动系统打开\n\nLaunchServices cold-open fixture.')
await writeFile(b, '# 后台系统打开\n\nLaunchServices warm-open fixture.')
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const before = await Promise.all([a, b].map(hash))
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
let browser, pid
try {
  await run('/usr/bin/open', ['-n', '-a', appPath, a, '--args', `--user-data-dir=${join(root, 'profile')}`, `--remote-debugging-port=${port}`])
  await expect.poll(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true } catch { return false }
  }, { timeout: 20000 }).toBe(true)
  const cdp = await browser.newBrowserCDPSession()
  const info = await cdp.send('SystemInfo.getProcessInfo')
  pid = info.processInfo.find(item => item.type === 'browser')?.id
  await expect.poll(() => browser.contexts()[0].pages().length).toBe(1)
  const page = browser.contexts()[0].pages()[0]
  await expect(page.getByRole('heading', { name: '冷启动系统打开', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'cold-open.png') })
  await run('/usr/bin/open', ['-a', appPath, b])
  await expect(page.getByRole('heading', { name: '后台系统打开', exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await run('/usr/bin/open', ['-a', appPath, a])
  await expect(page.getByRole('heading', { name: '冷启动系统打开', exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.screenshot({ path: join(output, 'warm-reopen.png') })
  const after = await Promise.all([a, b].map(hash))
  expect(after).toEqual(before)
  const { stdout: version } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents/Info.plist')])
  const { stdout: types } = await run('/usr/bin/plutil', ['-extract', 'CFBundleDocumentTypes', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')])
  const documentTypes = JSON.parse(types)
  expect(documentTypes).toEqual(expect.arrayContaining([expect.objectContaining({ CFBundleTypeExtensions: ['md', 'markdown'], LSHandlerRank: 'Alternate' })]))
  const result = { platform: process.platform, architecture: process.arch, kernel: release(), version: version.trim(), appPath, appAsarSha256: await hash(join(appPath, 'Contents/Resources/app.asar')), root, documentTypes, checks: ['native cold open-file', 'native warm open-file', 'native duplicate activation', 'two tabs in one window', 'source hashes unchanged'], before, after }
  await writeFile(join(output, 'launchservices.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  try {
    if (browser) await browser.close()
  } finally {
    try {
      if (pid) {
        try { process.kill(pid, 'SIGTERM') } catch { /* already closed */ }
        await expect.poll(() => {
          try { process.kill(pid, 0); return true } catch { return false }
        }, { timeout: 10000 }).toBe(false)
      }
    } finally { await unregisterMacBuild(appPath) }
  }
}
