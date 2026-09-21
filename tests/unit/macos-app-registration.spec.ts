import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unregisterMacBuild, withMacBuildRegistrationCleanup } from '../../scripts/macos-app-registration.mjs'

describe('managed macOS build registration cleanup', () => {
  let root: string
  let app: string
  let installed: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-registration-')))
    app = join(root, '.tooling/mac-builds/1.2.3/mac-arm64/InkNest.app')
    installed = join(root, 'Applications/InkNest.app')
    for (const path of [app, installed]) {
      await mkdir(join(path, 'Contents'), { recursive: true })
      await writeFile(join(path, 'Contents/Info.plist'), 'preserved bundle metadata')
    }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function runner(identifier = 'io.inknest.app') {
    return vi.fn(async (command: string) => ({ stdout: command === '/usr/bin/plutil' ? identifier + '\n' : '' }))
  }
  it('unregisters exactly one owned bundle without changing the bundle or invoking a scan/reset', async () => {
    const run = runner()
    expect(await unregisterMacBuild(app, { root, platform: 'darwin', run })).toEqual({ status: 'unregistered', appPath: app })
    expect(run.mock.calls).toEqual([
      ['/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { timeout: 10000 }],
      ['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app], { timeout: 10000 }]
    ])
    expect(await readFile(join(app, 'Contents/Info.plist'), 'utf8')).toBe('preserved bundle metadata')
    expect(await readFile(join(installed, 'Contents/Info.plist'), 'utf8')).toBe('preserved bundle metadata')
  })
  it('never touches installed apps, mounted volumes, other roots, or ordinary development Electron', async () => {
    const run = runner()
    for (const path of [installed, '/Applications/InkNest.app', '/Volumes/InkNest/InkNest.app', join(root, 'Downloads/InkNest.app'), join(root, 'node_modules/electron/dist/Electron.app'), join(root, '.tooling/mac-builds/1.2.3/mac-arm64/../InkNest.app')]) {
      expect(await unregisterMacBuild(path, { root, platform: 'darwin', run })).toMatchObject({ status: 'skipped', reason: 'not-managed-build' })
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('skips non-Mac hosts and build failures which produced no app', async () => {
    const run = runner()
    expect(await unregisterMacBuild(app, { root, platform: 'win32', run })).toMatchObject({ reason: 'not-macos' })
    await rm(app, { recursive: true })
    expect(await unregisterMacBuild(app, { root, platform: 'darwin', run })).toMatchObject({ reason: 'missing-build' })
    expect(run).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32')('rejects app and parent symlinks into an installed app', async () => {
    const run = runner()
    await rm(app, { recursive: true })
    await symlink(installed, app)
    await expect(unregisterMacBuild(app, { root, platform: 'darwin', run })).rejects.toThrow('redirected')
    await rm(join(root, '.tooling'), { recursive: true })
    const outside = join(root, 'external')
    await mkdir(join(outside, 'mac-builds/1.2.3/mac-arm64/InkNest.app'), { recursive: true })
    await symlink(outside, join(root, '.tooling'))
    await expect(unregisterMacBuild(app, { root, platform: 'darwin', run })).rejects.toThrow('redirected')
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects another bundle identifier before calling lsregister', async () => {
    const run = runner('com.example.other')
    await expect(unregisterMacBuild(app, { root, platform: 'darwin', run })).rejects.toThrow('different application')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('accepts only the exact not-registered response and propagates other failures', async () => {
    const absent = { code: 1, stderr: `failed to scan ${app}: -10814\n from spotlight`, signal: null, killed: false }
    const run = vi.fn(async (command: string) => {
      if (command === '/usr/bin/plutil') return { stdout: 'io.inknest.app\n' }
      throw absent
    })
    expect(await unregisterMacBuild(app, { root, platform: 'darwin', run })).toEqual({ status: 'already-unregistered', appPath: app })
    for (const error of [
      { ...absent, killed: true },
      { ...absent, stderr: `failed to scan ${app}: -10822` },
      { ...absent, stderr: `failed to scan ${installed}: -10814` },
      { code: 'ENOENT' }
    ]) {
      run.mockImplementation(async (command: string) => {
        if (command === '/usr/bin/plutil') return { stdout: 'io.inknest.app\n' }
        throw error
      })
      await expect(unregisterMacBuild(app, { root, platform: 'darwin', run })).rejects.toBe(error)
    }
  })
  it('cleans up after success and failure, preserving both failures if cleanup also fails', async () => {
    const run = runner()
    const options = { root, platform: 'darwin', run }
    expect(await withMacBuildRegistrationCleanup(app, async () => 42, options)).toBe(42)
    expect(run).toHaveBeenCalledTimes(2)
    const failure = new Error('verification failed')
    await expect(withMacBuildRegistrationCleanup(app, async () => { throw failure }, options)).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(4)
    const cleanupFailure = new Error('registration service unavailable')
    const failing = vi.fn(async (command: string) => {
      if (command === '/usr/bin/plutil') return { stdout: 'io.inknest.app\n' }
      throw cleanupFailure
    })
    await expect(withMacBuildRegistrationCleanup(app, async () => 42, { ...options, run: failing })).rejects.toBe(cleanupFailure)
    await expect(withMacBuildRegistrationCleanup(app, async () => { throw failure }, { ...options, run: failing })).rejects.toMatchObject({ errors: [failure, cleanupFailure] })
  })
})
