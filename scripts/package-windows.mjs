// Build Windows with Windows production dependencies, even on a macOS host.
import { cp, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build, Platform, Arch } from 'electron-builder'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (!process.env.npm_execpath) throw new Error('Run this script through npm run dist:win or npm run dist:all')
await mkdir(join(root, '.tooling'), { recursive: true })
const staging = await mkdtemp(join(root, '.tooling', `windows-${metadata.version}-`))
await copyFile(join(root, 'package.json'), join(staging, 'package.json'))
await copyFile(join(root, 'package-lock.json'), join(staging, 'package-lock.json'))
await cp(join(root, 'out'), join(staging, 'out'), { recursive: true, filter: source => !source.endsWith('.DS_Store') })
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--os=win32', '--cpu=x64', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit' })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Windows dependency installation exited ${code}`)))
})
await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never', config: { extends: join(root, 'electron-builder.yml'), directories: { app: staging } } })
console.log(`Windows ${metadata.version} built from isolated dependency directory ${staging}`)
