// Keep unpacked development apps out of Finder's normal application discovery.
import { mkdir, readdir, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build, Platform, Arch } from 'electron-builder'
import { projectRoot as root, readReleaseConfig } from './release-config.mjs'
const config = await readReleaseConfig()
const staging = config.macStaging
const output = process.argv[2] ? resolve(root, process.argv[2]) : config.directory
await mkdir(output, { recursive: true })
await build({ projectDir: root, targets: Platform.MAC.createTarget(['dmg'], Arch.arm64), publish: 'never', config: { extends: join(root, 'electron-builder.yml'), directories: { output: staging } } })
for (const name of await readdir(staging)) {
  if (name.endsWith('.dmg') || name.endsWith('.dmg.blockmap')) await rename(join(staging, name), join(output, name))
}
console.log(`Mac ${config.version} DMG: ${output}; unpacked validation app: ${config.macApp}`)
