import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function releaseConfig(version, root = projectRoot) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error('Release version must be a stable version such as 0.1.1')
  }
  const directory = join(root, 'release', version)
  const fixtureName = `InkNest-${version}-smoke-fixtures`
  return {
    version, tag: `v${version}`, directory, fixtureName,
    fixtureDirectory: join(directory, fixtureName),
    macStaging: join(root, '.tooling', 'mac-builds', version),
    macApp: join(root, '.tooling', 'mac-builds', version, 'mac-arm64', 'InkNest.app'),
    winDirectory: join(directory, 'win-unpacked'),
    installers: [`InkNest-${version}-win-x64.exe`, `InkNest-${version}-mac-arm64.dmg`]
  }
}

export async function readReleaseConfig(root = projectRoot) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const config = releaseConfig(pkg.version, root)
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions differ; run npm run version:set -- <version>')
  }
  return config
}
