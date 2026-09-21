// Development-host cleanup only. Never ship this maintenance command in the app.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { projectRoot } from './release-config.mjs'

const runFile = promisify(execFile)
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export async function unregisterMacBuild(appPath, { root = projectRoot, platform = process.platform, run = runFile } = {}) {
  if (platform !== 'darwin') return { status: 'skipped', reason: 'not-macos' }
  const base = resolve(root)
  const candidate = resolve(appPath)
  const localPath = relative(base, candidate).split(sep).join('/')
  // Only our versioned, unpacked arm64 build directory is owned by this workflow.
  // In particular, /Applications, Downloads and mounted DMGs are not candidates.
  if (!/^\.tooling\/mac-builds\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\/mac-arm64\/InkNest\.app$/u.test(localPath)) {
    return { status: 'skipped', reason: 'not-managed-build' }
  }
  let canonical
  try { canonical = await realpath(candidate) }
  catch (error) { if (error.code === 'ENOENT') return { status: 'skipped', reason: 'missing-build' }; throw error }
  if (canonical !== join(await realpath(base), localPath)) throw new Error('Refusing to unregister a redirected build path')
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(canonical, 'Contents', 'Info.plist')], { timeout: 10000 })
  if (stdout.trim() !== 'io.inknest.app') throw new Error('Refusing to unregister a different application')
  // No recursive scans, database reset, default-handler changes or process kills.
  try { await run(lsregister, ['-u', canonical], { timeout: 10000 }) }
  catch (error) {
    // kLSApplicationNotFoundErr: a fresh, never-launched build has no record.
    // Match only this target's diagnostic; permission/service/timeout errors fail.
    const lines = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.split('\n').map(line => line.trim())
    if (error.code === 1 && !error.killed && !error.signal && lines.includes(`failed to scan ${canonical}: -10814`)) {
      return { status: 'already-unregistered', appPath: canonical }
    }
    throw error
  }
  return { status: 'unregistered', appPath: canonical }
}

export async function withMacBuildRegistrationCleanup(appPath, operation, options) {
  let value, operationError, failed = false
  try { value = await operation() }
  catch (error) { operationError = error; failed = true }
  try { await unregisterMacBuild(appPath, options) }
  catch (error) {
    if (failed) throw new AggregateError([operationError, error], 'Operation and build registration cleanup failed', { cause: error })
    throw error
  }
  if (failed) throw operationError
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/macos-app-registration.mjs <managed InkNest.app path>')
  console.log(JSON.stringify(await unregisterMacBuild(process.argv[2]), null, 2))
}
