import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readReleaseConfig, projectRoot } from './release-config.mjs'
import { createSmokeBundle } from './create-smoke-bundle.mjs'
import { inspectPackages } from './package-inspection.mjs'

const config = await readReleaseConfig()
const [command, platform = 'all'] = process.argv.slice(2)
if (command === 'fixtures') {
  console.log(JSON.stringify(await createSmokeBundle(config.directory, config.version), null, 2))
} else if (command === 'inspect') {
  if (!['mac', 'win', 'all'].includes(platform)) throw new Error('Use inspect mac, win or all')
  const result = await inspectPackages({
    expectedVersion: config.version,
    macApp: platform !== 'win' ? config.macApp : undefined,
    winDirectory: platform !== 'mac' ? config.winDirectory : undefined
  })
  await mkdir(config.directory, { recursive: true })
  await writeFile(join(config.directory, 'package-inspection.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} else if (command === 'verify-mac') {
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts/verify-packaged-macos.mjs'),
    '--phase', 'smoke', '--expected-version', config.version, '--app', config.macApp,
    '--fixtures', config.fixtureDirectory, '--evidence-dir', join(config.directory, 'packaged-smoke'),
    '--output', join(config.directory, 'macos-packaged-verification.json')], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  throw new Error('Use fixtures, inspect or verify-mac')
}
