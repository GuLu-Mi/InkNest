// Diagnostic benchmark, not a release performance acceptance test. No user files.
/* global window */
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const [projectArg, outputArg] = process.argv.slice(2)
if (!projectArg || !outputArg) throw Error('Usage: node scripts/measure-saved-history.mjs PROJECT OUTPUT.json')
const project = resolve(projectArg); const output = resolve(outputArg)
const results = { definition: '10 serial automatic saves via production preload IPC of fixed snapshots; all opened tabs hold independent document sessions. Save latency ends on receipt; list latency ends on verified list metadata reply. UI refreshed rows separately observed. Three seconds natural idle before RSS, no forced GC. Native picker return substituted. All temporary samples.', project, cases: [] }
const p95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]
async function size(path) {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) { const p = join(path, entry.name); bytes += entry.isDirectory() ? await size(p) : (await stat(p)).size }
  return bytes
}
for (const byteLength of [100 * 1024, 2 * 1024 * 1024]) for (const tabs of [1, 20]) {
  const root = await mkdtemp(join(tmpdir(), 'inknest-history-bench-')); let app
  try {
    const text = '# Benchmark\n\n' + 'fixed paragraph for saved history.\n\n'.repeat(Math.ceil(byteLength / 36))
    const sample = text.padEnd(byteLength, ' ').slice(0, byteLength)
    app = await electron.launch({ args: [join(project, 'out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`], cwd: project, chromiumSandbox: true })
    const page = await app.firstWindow(); await page.waitForFunction(() => !!window.inknest)
    let document
    for (let i = 0; i < tabs; i++) {
      const file = join(root, `sample-${i}.md`); await writeFile(file, sample)
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
      const opened = await page.evaluate(() => window.inknest.openFile())
      if (opened.status !== 'ok') throw Error(JSON.stringify(opened))
      document = opened.value
    }
    await expect(page.getByRole('tab')).toHaveCount(tabs)
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    const savesMs = []; const listMs = []; let listing
    for (let revision = 1; revision <= 10; revision++) {
      const result = await page.evaluate(async ({ document, revision, requestId }) => {
        const started = performance.now()
        const saved = await window.inknest.save({ requestId, snapshot: { docId: document.docId, epoch: document.epoch, revision, text: String(revision % 10) + document.text.slice(1) }, expectedDiskToken: document.diskToken, trigger: 'auto' })
        const saveMs = performance.now() - started; const beforeList = performance.now()
        const listing = await window.inknest.listHistory({ docId: document.docId, epoch: document.epoch })
        return { saved, saveMs, listing, listMs: performance.now() - beforeList }
      }, { document, revision, requestId: randomUUID() })
      if (result.saved.status !== 'ok' || result.listing.status !== 'ok') throw Error(JSON.stringify(result))
      document.diskToken = result.saved.value.diskToken
      savesMs.push(result.saveMs); listMs.push(result.listMs); listing = result.listing.value
    }
    const entries = Array.isArray(listing) ? listing : listing.entries
    // The benchmark calls main directly; reopen the UI list for both builds so
    // old diskToken-only refresh and new generation refresh share one endpoint.
    await page.getByRole('button', { name: '关闭历史', exact: true }).click()
    const refreshStarted = performance.now()
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await expect(page.locator('.history-list li')).toHaveCount(entries.length)
    const listUiRefreshMs = performance.now() - refreshStarted
    await page.waitForTimeout(3000)
    const rssMiB = await app.evaluate(({ app }) => app.getAppMetrics().reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024)
    const value = { byteLength, tabs, savesMs, saveP95Ms: p95(savesMs), listMs, listP95Ms: p95(listMs), listUiRefreshMs, historyRows: entries.length, physicalHistoryBytes: await size(join(root, 'profile/history')), rssMiB }
    results.cases.push(value); await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(results, null, 2)); console.log(JSON.stringify(value))
  } finally { app?.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
}
