import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js'
import { inspectNsis, inspectNsisInstaller } from '../../scripts/nsis-integrity.mjs'
const valid = () => readFile('tests/fixtures/nsis/valid-uninstaller.exe')
test('accepts native NSIS CRC and detects the actual Mac extractor icon mismatch', async () => {
  expect(inspectNsis(await valid())).toMatchObject({ uninstaller: true })
  const bad = await readFile('tests/fixtures/nsis/bad-icon-uninstaller.exe')
  expect(() => inspectNsis(bad)).toThrow('CRC')
})
test('rejects truncated and corrupted uninstallers instead of trusting the enclosing installer', async () => {
  const bytes = await valid()
  expect(() => inspectNsis(bytes.subarray(0, bytes.length - 1))).toThrow('truncated')
  bytes[1024] = bytes[1024]! ^ 1
  expect(() => inspectNsis(bytes)).toThrow('CRC')
})
test('refuses CRC-disabled executables and invalid headers', async () => {
  const bytes = await valid(); const offset = inspectNsis(bytes).headerOffset
  bytes.writeUInt32LE(5, offset)
  expect(() => inspectNsis(bytes)).toThrow('disabled')
  expect(() => inspectNsis(Buffer.alloc(1024))).toThrow('PE')
})
test('extracts and validates the actual embedded uninstaller with the platform tool', async () => {
  const result = await inspectNsisInstaller('tests/fixtures/nsis/extraction-installer.exe')
  expect(result.installer.uninstaller).toBe(false)
  expect(result.uninstaller).toEqual(inspectNsis(await valid()))
}, 60_000)
test.skipIf(process.platform !== 'win32')('rejects the limited Windows builder 7za with an actionable extraction error', async () => {
  await expect(inspectNsisInstaller('tests/fixtures/nsis/extraction-installer.exe', await getPath7za()))
    .rejects.toThrow('NSIS extraction failed')
}, 60_000)
