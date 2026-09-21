// Keep unpacked development apps out of Finder's normal application discovery.
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const staging = join(root, '.tooling', 'mac-builds', metadata.version)
if (!process.argv[2]) throw new Error('Provide the release output directory')
const output = resolve(root, process.argv[2])
await mkdir(output, { recursive: true })
await build({ projectDir: root, targets: Platform.MAC.createTarget(['dmg'], Arch.arm64), publish: 'never', config: { extends: join(root, 'electron-builder.yml'), directories: { output: staging } } })
for (const name of await readdir(staging)) {
  if (name.endsWith('.dmg') || name.endsWith('.dmg.blockmap')) await rename(join(staging, name), join(output, name))
}
console.log(`Mac ${metadata.version} DMG: ${output}; unpacked validation app: ${join(staging, 'mac-arm64', 'InkNest.app')}`)
