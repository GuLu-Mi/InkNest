import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { extractFile, listPackage } from '@electron/asar'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function inspectExecutableArchitecture(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4)
    if (cpu === 0x0100000c) return { format: 'Mach-O', architecture: 'arm64' }
    if (cpu === 0x01000007) return { format: 'Mach-O', architecture: 'x64' }
    return { format: 'Mach-O', architecture: `unknown-0x${cpu.toString(16)}` }
  }
  if (bytes.subarray(0, 2).toString('ascii') === 'MZ') {
    if (bytes.length < 0x40) throw new Error('Truncated PE executable')
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset + 6 > bytes.length) throw new Error('Truncated PE executable')
    assert(bytes.subarray(peOffset, peOffset + 4).toString('binary') === 'PE\0\0', 'Invalid PE signature')
    const machine = bytes.readUInt16LE(peOffset + 4)
    if (machine === 0x8664) return { format: 'PE', architecture: 'x64' }
    if (machine === 0xaa64) return { format: 'PE', architecture: 'arm64' }
    if (machine === 0x014c) return { format: 'PE', architecture: 'ia32' }
    return { format: 'PE', architecture: `unknown-0x${machine.toString(16)}` }
  }
  throw new Error('Unsupported executable format')
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export function textFromAsar(archive, path) {
  // @electron/asar traverses using the host's path separator, including on Windows.
  return extractFile(archive, normalize(path)).toString('utf8')
}

export function listAsarEntries(archive) {
  // Keep package contract checks independent of the host's directory notation.
  return listPackage(archive).map(entry => entry.split(sep).join('/').replace(/^\//u, '')).sort()
}

// Explicit contract from docs/contracts.md; never derived from the package under inspection.
const APPROVED_CHANNELS = [
  'backup:checkpoint', 'backup:clear', 'backup:discard-recovery', 'backup:export-history',
  'backup:inspect-history', 'backup:inspect-recovery', 'backup:list-history', 'backup:list-recovery',
  'backup:restore-history', 'backup:restore-recovery', 'document:activate', 'document:close', 'document:complete-close',
  'document:conflict', 'document:event', 'document:link', 'document:open', 'document:reconcile',
  'document:renderer-ready', 'document:resources', 'document:save', 'document:save-as', 'settings:set-theme', 'settings:theme', 'window:presentation'
]

export function inspectPreloadChannels(preload) {
  const calls = [...preload.matchAll(/ipcRenderer\.(?:invoke|on|removeListener)\(\s*([^,\n)]+)/gu)]
  assert(calls.every(call => /^["'][a-z-]+:[a-z-]+["']$/u.test(call[1])), 'dynamic preload IPC channel')
  const channels = [...new Set(calls.map(call => call[1].slice(1, -1)))].sort()
  assert(JSON.stringify(channels) === JSON.stringify(APPROVED_CHANNELS), `unexpected preload IPC channels ${channels.join(', ')}`)
  return channels
}

export function inspectProcessBoundary(main, preload) {
  assert(!/ipcRenderer\.(?:send|sendSync|postMessage)|ipcMain\.(?:on|once)|child_process/u.test(`${main}\n${preload}`), 'generic IPC or process execution found')
  assert(!/shell\.(?:openExternal|openPath|showItemInFolder)/u.test(preload), 'preload exposes a shell primitive')
  // External dispatch belongs only to the validated document-link main handler.
  if (/shell\.(?:openExternal|openPath|showItemInFolder)/u.test(main)) {
    assert(main.includes('new LinkRouter(') && main.includes('validLinkArgs(args)') && main.includes('isTrustedCaller(event, window.webContents') && main.includes('ipcMain.handle("document:link"'), 'missing controlled link route')
  }
}
async function inspectImageRuntime(archive, entries, architecture) {
  const sharp = JSON.parse(textFromAsar(archive, 'node_modules/sharp/package.json'))
  assert(sharp.version === '0.35.4', 'unexpected sharp runtime version')
  const platform = architecture === 'arm64' ? 'darwin-arm64' : 'win32-x64'
  const nativeEntries = entries.filter(entry => entry.startsWith(`node_modules/@img/sharp-${platform}/`) && entry.endsWith('.node'))
  const libraries = entries.filter(entry => architecture === 'arm64' ? entry.startsWith('node_modules/@img/sharp-libvips-darwin-arm64/') && entry.endsWith('.dylib') : entry.startsWith('node_modules/@img/sharp-win32-x64/') && entry.endsWith('.dll'))
  assert(nativeEntries.length === 1 && libraries.length > 0, 'missing platform image runtime')
  assert(!entries.some(entry => /node_modules\/@img\/sharp-(?:darwin|win32)-/u.test(entry) && !entry.startsWith(`node_modules/@img/sharp-${platform}/`) && !entry.endsWith(`sharp-${platform}`)), 'foreign platform image runtime bundled')
  const files = []
  for (const entry of [...nativeEntries, ...libraries]) {
    const path = `${archive}.unpacked/${entry}`
    const binary = inspectExecutableArchitecture(await readFile(path))
    assert(binary.architecture === architecture, `wrong image binary architecture: ${entry}`)
    files.push({ path: entry, ...binary, sha256: await sha256(path) })
  }
  return { sharpVersion: sharp.version, platform, files }
}

async function inspectPackage(label, archive, executable, expectedArchitecture, expectedVersion) {
  const entries = listAsarEntries(archive)
  const metadata = JSON.parse(textFromAsar(archive, 'package.json'))
  const main = textFromAsar(archive, 'out/main/index.js')
  const preload = textFromAsar(archive, 'out/preload/index.js')
  const html = textFromAsar(archive, 'out/renderer/index.html')
  const decodedHtml = html.replaceAll('&#39;', "'")
  const executableArchitecture = inspectExecutableArchitecture(await readFile(executable))

  assert(metadata.version === expectedVersion, `${label}: unexpected app version ${metadata.version}`)
  assert(metadata.main === 'out/main/index.js', `${label}: unexpected main entry ${metadata.main}`)
  assert(executableArchitecture.architecture === expectedArchitecture, `${label}: expected ${expectedArchitecture}, got ${executableArchitecture.architecture}`)
  assert(entries.some((entry) => entry.startsWith('node_modules/write-file-atomic/')), `${label}: write-file-atomic runtime dependency missing`)
  assert(!/ELECTRON_RENDERER_URL|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|wss?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/u.test(main), `${label}: development remote loading string found`)
  assert(/APP_SCHEME = "inknest"/u.test(main) && /APP_HOST = "app"/u.test(main) && /loadURL\(`\$\{APP_SCHEME\}:\/\/\$\{APP_HOST\}\/`\)/u.test(main), `${label}: packaged protocol entry missing`)
  for (const preference of ['nodeIntegration: false', 'contextIsolation: true', 'sandbox: true', 'webSecurity: true']) {
    assert(main.includes(preference), `${label}: missing secure preference ${preference}`)
  }
  inspectProcessBoundary(main, preload)
  const imageRuntime = await inspectImageRuntime(archive, entries, expectedArchitecture)
  const channels = inspectPreloadChannels(preload)
  assert(/default-src 'self'/u.test(decodedHtml) && /connect-src 'none'/u.test(decodedHtml), `${label}: production CSP is not embedded`)

  return {
    label,
    archive,
    archiveSha256: await sha256(archive),
    executable,
    executableSha256: await sha256(executable),
    executableArchitecture,
    appVersion: metadata.version,
    main: metadata.main,
    entryCount: entries.length,
    runtimeDependencyPresent: true,
    imageRuntime,
    securePreferencesPresent: true,
    developmentRemoteLoadingAbsent: true,
    preloadChannels: channels
  }
}

export async function inspectPackages({ macApp, winDirectory, expectedVersion }) {
  assert(typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(expectedVersion), 'Provide an independent expected version')
  const packages = []
  if (macApp) {
    packages.push(await inspectPackage(
      'macOS arm64',
      join(macApp, 'Contents', 'Resources', 'app.asar'),
      join(macApp, 'Contents', 'MacOS', 'InkNest'),
      'arm64', expectedVersion
    ))
  }
  if (winDirectory) {
    packages.push(await inspectPackage(
      'Windows x64',
      join(winDirectory, 'resources', 'app.asar'),
      join(winDirectory, 'InkNest.exe'),
      'x64', expectedVersion
    ))
  }
  assert(packages.length > 0, 'Provide --mac-app and/or --win-dir')
  return { schemaVersion: 2, expectedVersion, packages }
}

function parseArguments(arguments_) {
  const result = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument near ${name ?? '<end>'}`)
    result[name.slice(2)] = name === '--expected-version' ? value : resolve(value)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arguments_ = parseArguments(process.argv.slice(2))
  const result = await inspectPackages({ macApp: arguments_['mac-app'], winDirectory: arguments_['win-dir'], expectedVersion: arguments_['expected-version'] })
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (arguments_.output) await writeFile(arguments_.output, output, 'utf8')
  process.stdout.write(output)
  process.stderr.write(`Inspected ${result.packages.length} package(s): ${result.packages.map((item) => basename(item.executable)).join(', ')}\n`)
}
