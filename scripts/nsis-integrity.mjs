import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js'
const signature = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex')
function assert(condition, message) { if (!condition) throw new Error(message) }
// Match NSIS exehead/fileform.c: header at a 512-byte boundary, CRC from
// byte 512 to the header-declared end minus four (Authenticode trailer excluded).
export function inspectNsis(bytes) {
  assert(bytes.length >= 512 && bytes.subarray(0, 2).toString('ascii') === 'MZ', 'Invalid NSIS PE')
  let headerOffset = -1
  for (let offset = 512; offset + 28 <= bytes.length; offset += 512) {
    if (bytes.subarray(offset + 4, offset + 20).equals(signature) && (bytes.readUInt32LE(offset) & ~15) === 0) { headerOffset = offset; break }
  }
  assert(headerOffset >= 0, 'NSIS header missing or truncated')
  const flags = bytes.readUInt32LE(headerOffset)
  assert((flags & 4) === 0, 'NSIS CRC is disabled')
  const length = bytes.readUInt32LE(headerOffset + 24)
  const end = headerOffset + length
  assert(length >= 32 && end <= bytes.length, 'NSIS data is truncated')
  const expected = bytes.readUInt32LE(end - 4)
  const actual = crc32(bytes.subarray(512, end - 4))
  assert(actual === expected, `NSIS CRC mismatch: expected ${expected.toString(16)}, actual ${actual.toString(16)}`)
  return { headerOffset, uninstaller: !!(flags & 1), crc: expected.toString(16), sha256: createHash('sha256').update(bytes).digest('hex') }
}
export async function inspectNsisInstaller(path, sevenZip) {
  const installer = inspectNsis(await readFile(path))
  assert(!installer.uninstaller, 'Expected installer, received uninstaller')
  // Builder's Windows 7za.exe cannot read NSIS. Its Unix "7za" is full 7zz.
  // Force NSIS so a limited tool cannot silently open the nested application 7z.
  const extractor = sevenZip ?? process.env.INKNEST_NSIS_7ZIP_PATH ?? (process.platform === 'win32'
    ? join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe')
    : await getPath7za())
  let stdout
  try {
    const extracted = await promisify(execFile)(extractor, ['e', resolve(path), '-tNsis', '-so', '-r', '*Uninstall*.exe'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
    stdout = extracted.stdout
  } catch (cause) {
    throw new Error('NSIS extraction failed. Install full 7-Zip (7z.exe with 7z.dll) or set INKNEST_NSIS_7ZIP_PATH to an NSIS-capable executable; standalone Windows 7za.exe is not supported.', { cause })
  }
  assert(stdout.length > 0, 'No embedded uninstaller found in NSIS archive')
  const uninstaller = inspectNsis(stdout)
  assert(uninstaller.uninstaller, 'Missing embedded uninstaller')
  return { installer, uninstaller }
}
// Builder hook fails the build if the final artifact contains a bad uninstaller.
export default async function verifyArtifacts(result) {
  for (const path of result.artifactPaths.filter(path => path.endsWith('.exe'))) {
    await writeFile(`${path}.integrity.json`, JSON.stringify(await inspectNsisInstaller(path), null, 2) + '\n')
  }
  return []
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await inspectNsisInstaller(process.argv[2])
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
