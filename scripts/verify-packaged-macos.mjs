import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { _electron as electron, expect } from '@playwright/test'

function assert(condition, message) { if (!condition) throw new Error(message) }
export function summarize(samples, requiredCount) {
  if (!samples.length) return { count: 0, complete: false }
  const sorted = [...samples].sort((a, b) => a - b)
  return { count: samples.length, complete: samples.length === requiredCount,
    minimumMs: sorted[0], p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    // Partial attempts intentionally have no acceptance p95.
    ...(samples.length === requiredCount ? { p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] } : {}),
    maximumMs: sorted.at(-1) }
}
async function closeApp(app, result) {
  let timer
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned app clean close exceeded 5s')), 5000) })])
  } catch (error) {
    result.cleanupFailures.push(String(error))
    app.process().kill('SIGKILL')
  } finally { clearTimeout(timer) }
}
async function launch(executable, userData) {
  const env = { ...process.env, ELECTRON_RENDERER_URL: 'https://example.invalid/should-not-load' }
  delete env.NO_COLOR
  return electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], chromiumSandbox: true, timeout: 20000, env })
}
async function ready(app) {
  const page = await app.firstWindow({ timeout: 15000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1920, 1080) })
  await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开文档', exact: true }).first()).toBeEnabled()
  return page
}
async function select(app, page, path, heading) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
  await page.getByRole('button', { name: '打开文档', exact: true }).first().click()
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', path)
  if (heading) await expect(page.locator('.preview').getByRole('heading', { name: heading, exact: true })).toBeVisible()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function closeActive(page) {
  const count = await page.getByRole('tab').count()
  await page.locator('.document-tab.selected .close-tab').click()
  await expect(page.getByRole('tab')).toHaveCount(count - 1)
}
async function metrics(app, page) {
  const memory = await app.evaluate(({ app }) => {
    const processes = app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, workingSetSizeKiB: metric.memory.workingSetSize }))
    return { processes, processCount: processes.length, summedWorkingSetSizeKiB: processes.reduce((sum, item) => sum + item.workingSetSizeKiB, 0) }
  })
  return { ...memory, dom: await page.evaluate(() => ({ tabs: document.querySelectorAll('[role="tab"]').length, editors: document.querySelectorAll('.cm-editor').length, previews: document.querySelectorAll('.preview').length, styles: document.querySelectorAll('style').length })) }
}

async function verifyIdentity(app, page, expectedVersion) {
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { isPackaged: app.isPackaged, version: app.getVersion(), architecture: process.arch, executable: app.getPath('exe'), userData: app.getPath('userData'),
      preferences: Object.fromEntries(['nodeIntegration', 'contextIsolation', 'sandbox', 'webSecurity'].map(key => [key, preferences[key]])) }
  })
  assert(identity.isPackaged && identity.version === expectedVersion && identity.architecture === 'arm64', 'Unexpected packaged identity')
  identity.rendererUrl = page.url()
  assert(page.url() === 'inknest://app/', 'Unexpected renderer URL')
  assert(JSON.stringify(identity.preferences) === JSON.stringify({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }), 'Security preferences changed')
  return identity
}

async function focusedFlows(executable, workspace, fixtureRoot, expectedVersion, result, persist) {
  const profile = join(workspace, 'focused-profile'); await mkdir(profile)
  // Force a real history failure so recovery is exercised before any formal save.
  await writeFile(join(profile, 'history'), 'isolated history failure fixture')
  const path = join(workspace, 'focused.md'); const copy = join(workspace, 'focused-copy.md')
  await writeFile(path, '# original')
  let app
  try {
    result.currentOperation = 'focused: open/checkpoint'; await persist()
    app = await launch(executable, profile); let page = await ready(app)
    result.identity = await verifyIdentity(app, page, expectedVersion)
    await select(app, page, path, 'original')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' recovered')
    await expect(page.locator('.document-status')).toContainText('草稿已备份', { timeout: 7000 })
    assert(await readFile(path, 'utf8') === '# original', 'Failed save changed original')
    const exited = new Promise(resolve => app.process().once('exit', resolve)); app.process().kill('SIGKILL'); await exited; app = undefined
    // Copy only the isolated app-created record to model a durable tombstone whose
    // prior unlink did not finish. The original record remains available to restore.
    const recoveryRoot = join(profile, 'recovery'); const [sourceId] = await readdir(recoveryRoot)
    const discardedId = randomUUID(); const discardedDir = join(recoveryRoot, discardedId)
    await cp(join(recoveryRoot, sourceId), discardedDir, { recursive: true })
    const manifestPath = join(discardedDir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.sessionId = discardedId; await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(discardedDir, 'discarded.json'), JSON.stringify({ schemaVersion: 1, sessionId: discardedId, discardedAt: new Date().toISOString() }))
    await writeFile(join(discardedDir, 'unknown.txt'), 'retain unknown content')
    await rm(join(profile, 'history'))
    result.currentOperation = 'focused: restart/reclaim/restore'; await persist()
    app = await launch(executable, profile); page = await ready(app)
    await verifyIdentity(app, page, expectedVersion)
    await expect(page.getByText('发现1份未保存稿', { exact: true })).toBeVisible()
    await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '本地备份…').click() })
    await expect(page.getByRole('dialog', { name: '本地备份', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toHaveCount(1)
    for (const record of manifest.snapshots) assert(!(await readdir(discardedDir)).includes(record.snapshot), 'Known discarded content was not reclaimed')
    assert(await readFile(join(discardedDir, 'unknown.txt'), 'utf8') === 'retain unknown content', 'Unknown content was removed')
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
    await expect(page.locator('.document-status')).toContainText('等待确认')
    await page.waitForTimeout(1200); assert(await readFile(path, 'utf8') === '# original', 'Unconfirmed recovery wrote original')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' saved')
    await expect.poll(() => readFile(path, 'utf8')).toBe('# original recovered saved')
    result.currentOperation = 'focused: consecutive conflicts/history/SaveAs'; await persist()
    await app.evaluate(({ dialog }, copy) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy }) }, copy)
    const overwritten = []
    for (let index = 1; index <= 4; index++) {
      await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(` edit${index}`)
      const external = `# external ${index}`; const target = index === 4 ? copy : path
      await writeFile(target, external)
      const identity = await stat(target)
      const token = createHash('sha256').update(JSON.stringify({ sha256: createHash('sha256').update(external).digest('hex'), dev: identity.dev, ino: identity.ino, format: { encoding: 'utf-8', bom: false, eol: 'lf' } })).digest('hex')
      if (index !== 3) overwritten.push({ target, external, token })
      if (index === 1 || index === 3) { await page.getByRole('button', { name: '查看磁盘版本', exact: true }).click(); await expect(page.getByLabel('磁盘版本', { exact: true })).toHaveText(external) }
      await page.getByRole('button', { name: index === 3 ? '另存为…' : '覆盖磁盘版本', exact: true }).click()
      const savedPath = index >= 3 ? copy : path
      await expect.poll(() => readFile(savedPath, 'utf8').catch(() => null)).toBe(`# original recovered saved${Array.from({ length: index }, (_, i) => ` edit${i + 1}`).join('')}`)
      await expect(page.getByRole('region', { name: '文档问题' })).toHaveCount(0)
      await expect(page.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
    }
    const historyRoot = join(profile, 'history'); const manifests = await Promise.all((await readdir(historyRoot)).map(async id => ({ id, value: JSON.parse(await readFile(join(historyRoot, id, 'manifest.json'), 'utf8')) })))
    for (const { target, external, token } of overwritten) {
      const entry = manifests.find(item => item.value.canonicalPath === target)
      const record = entry?.value.snapshots.find(record => record.capturedToken === token)
      assert(record && await readFile(join(historyRoot, entry.id, record.snapshot), 'utf8') === external, 'Overwrite history token/bytes mismatch')
    }
    result.currentOperation = 'focused: dirty close'; await persist()
    await page.getByRole('textbox').focus(); await page.keyboard.insertText(' close')
    await closeActive(page); assert((await readFile(copy, 'utf8')).includes(' close'), 'Dirty close lost latest text')
    await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
    result.smoke = { opened: true, realHistoryFailure: true, checkpointBeforeKill: true, discardedReclaimedAfterRestart: true, unknownPreserved: true, restoredPreviewGated: true, editedRecoveryAutosaved: true, consecutiveOverwrite: true, inspectSaveAsThenConflict: true, overwrittenHistoryTokenAndBytes: true, dirtyCloseSaved: true, welcomeAfterLastClose: true, nativePicker: 'replacement only', nativeIME: 'not tested' }
    // Verify another actual fixture opens under the same final payload.
    const fixture = join(workspace, 'fixture-copy'); await cp(fixtureRoot, fixture, { recursive: true })
    await select(app, page, join(fixture, 'docs', '中文 说明.md'), '中文本机冒烟'); await closeActive(page)
  } finally { if (app) await closeApp(app, result); await persist() }
}

async function surfaceFlows(executable, workspace, expectedVersion, evidenceDirectory, result, persist, nativeOnly) {
  const profile = join(workspace, 'surface-profile')
  const file = join(workspace, 'surface.md'); const exported = join(workspace, 'historical-export.md')
  const original = Buffer.from('\ufeff# Package history A\r\n\r\n## Original section\r\n\r\nOriginal bytes.\r\n')
  const current = '\ufeff# Package current B\r\n\r\n## Current section\r\n\r\nCurrent bytes.'
  await writeFile(file, original)
  let app
  const capture = async (page, name) => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await writeFile(join(evidenceDirectory, name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()]))) }
  try {
    result.currentOperation = 'surfaces: launch/open'; await persist()
    app = await launch(executable, profile); let page = await ready(app)
    result.identity = await verifyIdentity(app, page, expectedVersion)
    await app.evaluate(({ BrowserWindow }, nativeOnly) => BrowserWindow.getAllWindows()[0].setSize(nativeOnly ? 1400 : 1920, nativeOnly ? 900 : 1080), nativeOnly)
    await select(app, page, file, 'Package history A')
    if (nativeOnly) {
      result.currentOperation = 'native presentation: one actual packaged request'; await persist()
      await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]; const events = []
        Reflect.set(window, 'verificationNativeEvents', events)
        for (const event of ['enter-full-screen', 'leave-full-screen']) window.on(event, () => events.push({ event, at: new Date().toISOString(), fullscreen: window.isFullScreen() }))
        app.focus({ steal: true }); window.focus()
      })
      const started = performance.now(); await page.getByRole('button', { name: '进入演示', exact: true }).click()
      await expect.poll(async () => await page.locator('.presentation-stage').count() > 0 || await page.getByRole('alert').filter({ hasText: '未能进入全屏演示' }).count() > 0, { timeout: 13000 }).toBe(true)
      result.nativePresentation = await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { fullscreen: window.isFullScreen(), focused: window.isFocused(), events: Reflect.get(window, 'verificationNativeEvents') } })
      result.nativePresentation.elapsedMs = performance.now() - started
      if (result.nativePresentation.fullscreen) {
        await expect(page.getByRole('region', { name: '全屏连续阅读' })).toBeVisible()
        await capture(page, 'packaged-native-presentation.png'); await page.keyboard.press('Escape')
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => Reflect.get(BrowserWindow.getAllWindows()[0], 'verificationNativeEvents').some(event => event.event === 'leave-full-screen')), { timeout: 12000 }).toBe(true)
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false)
        await expect(page.locator('.presentation-stage')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '进入演示', exact: true })).toBeEnabled()
        await expect(page.locator('.preview h1')).toHaveText('Package history A')
        result.nativePresentation.exitFullscreen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
        result.nativePresentation.normalUiRestored = true
        await capture(page, 'packaged-native-exited.png')
        result.nativePresentation.status = 'actual packaged enter and exit observed'
      } else {
        await expect(page.getByRole('alert')).toContainText('未能进入全屏演示')
        await expect(page.getByRole('button', { name: '进入演示', exact: true })).toBeEnabled()
        await expect(page.locator('.preview h1')).toHaveText('Package history A')
        await capture(page, 'packaged-native-timeout-recovered.png')
        result.nativePresentation.status = 'pending native acceptance: no successful fullscreen; watchdog recovered UI'
      }
      result.nativePresentation.finalEvents = await app.evaluate(({ BrowserWindow }) => Reflect.get(BrowserWindow.getAllWindows()[0], 'verificationNativeEvents'))
      assert((await readFile(file)).equals(original), 'Presentation altered source bytes')
      return
    }
    const outline = page.getByRole('navigation', { name: '文档目录', exact: true })
    const bodyGeometry = () => page.locator('.document-content').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width, scroll: document.querySelector('.document-stage').scrollTop } })
    const centeredBody = await bodyGeometry()
    for (const label of ['关闭目录', '文档目录', '历史版本', '关闭历史']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      assert(JSON.stringify(await bodyGeometry()) === JSON.stringify(centeredBody), `Panel moved packaged document: ${label}`)
    }
    result.stablePanels = { unchangedBodyGeometry: true, geometry: centeredBody }
    await expect(outline).toBeVisible(); await outline.getByRole('button', { name: 'Original section', exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('# Package current B\n\n## Current section\n\nCurrent bytes.')
    await expect.poll(() => readFile(file, 'utf8')).toBe(current)
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    const savedRows = page.locator('.history-list li')
    await expect(savedRows).toHaveCount(2); await expect(savedRows.first()).toContainText('自动保存')
    const beforeSeal = await stat(file)
    await page.keyboard.press('ControlOrMeta+s'); await expect(savedRows.first()).toContainText('手动保存')
    assert((await stat(file)).mtimeMs === beforeSeal.mtimeMs, 'Clean manual seal rewrote Markdown')
    await savedRows.first().getByRole('button', { name: '预览', exact: true }).click()
    await expect(page.locator('.preview h1')).toHaveText('Package current B')
    result.savedHistory = { latestAutoImmediatelyVisible: true, baselineRetained: true, cleanManualSealsWithoutRewrite: true }
    await page.getByRole('complementary', { name: '历史版本', exact: true }).getByRole('button', { name: '预览', exact: true }).last().click()
    await expect(page.locator('.preview h1')).toHaveText('Package history A'); await expect(page.locator('.cm-editor')).toHaveCount(0)
    await expect(outline.getByRole('button', { name: 'Original section', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.insertText('NOT SAVED'); await page.keyboard.press('ControlOrMeta+s')
    assert(await readFile(file, 'utf8') === current, 'Historical browsing changed formal text')
    await capture(page, 'packaged-historical-outline.png')
    await app.evaluate(({ dialog, Menu }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '另存为…').click() }, exported)
    await expect.poll(() => readFile(exported).catch(() => null)).toEqual(original)
    const restorePageErrors = []
    page.on('pageerror', error => restorePageErrors.push(error.message))
    await app.evaluate(({ ipcMain, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      const original = Reflect.get(ipcMain, '_invokeHandlers').get('backup:restore-history'); let lose = true
      ipcMain.removeHandler('backup:restore-history')
      ipcMain.handle('backup:restore-history', async (...args) => {
        Reflect.set(globalThis, 'verificationRestoreRequest', args[1])
        const receipt = await original(...args)
        if (lose && receipt.status === 'ok') { lose = false; throw new Error('verification: lost successful restore reply') }
        return receipt
      })
    })
    result.currentOperation = 'surfaces: same-tab lost restore reply/receipt reconciliation/undo'; await persist()
    await page.locator('.history-list li.selected').getByRole('button', { name: '还原', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对还原结果', exact: true })).toBeVisible()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
    await expect(page.locator('.cm-line')).toHaveText(['# Package current B', '', '## Current section', '', 'Current bytes.'])
    await expect.poll(() => readFile(file)).toEqual(original)
    const oldRequest = await app.evaluate(() => Reflect.get(globalThis, 'verificationRestoreRequest'))
    const staleSave = await page.evaluate(request => window.inknest.save({ requestId: crypto.randomUUID(), snapshot: request.snapshot, expectedDiskToken: request.expectedDiskToken, trigger: 'auto' }), oldRequest)
    assert(staleSave.status === 'error' && (await readFile(file)).equals(original), 'Old revision overwrote restored history')
    await page.evaluate(() => Reflect.set(window, 'verificationRestoreView', Reflect.get(document.querySelector('.cm-content'), 'cmTile').root.view))
    await capture(page, 'packaged-lost-reply-frozen.png')
    await page.getByRole('button', { name: '核对还原结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对还原结果', exact: true })).toHaveCount(0)
    const acceptedEditorText = await page.evaluate(() => Reflect.get(window, 'verificationRestoreView').state.doc.toString())
    assert(acceptedEditorText === '# Package history A\n\n## Original section\n\nOriginal bytes.\n', 'Mounted editor missed the accepted restore transaction')
    assert(restorePageErrors.length === 0, 'Same-tab restore raised renderer errors')
    result.sameTabRestore = { lostReplySourceFrozen: true, staleSaveRejected: staleSave.status, acceptedEditorText, diskSha256: createHash('sha256').update(await readFile(file)).digest('hex'), pageErrors: restorePageErrors }
    await expect(page.getByRole('button', { name: '返回当前文档', exact: true })).toHaveCount(0)
    await expect.poll(() => readFile(file)).toEqual(original)
    await expect(page.locator('.preview h1')).toHaveText('Package history A')
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox').focus(); await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.cm-line')).toHaveText(['# Package current B', '', '## Current section', '', 'Current bytes.'])
    await page.keyboard.press('ControlOrMeta+s'); await expect.poll(() => readFile(file, 'utf8')).toBe(current)
    const historyRoot = join(profile, 'history'); const protectedBodies = []
    for (const directory of await readdir(historyRoot)) {
      const manifest = JSON.parse(await readFile(join(historyRoot, directory, 'manifest.json'), 'utf8'))
      for (const record of manifest.snapshots) protectedBodies.push(await readFile(join(historyRoot, directory, record.snapshot), 'utf8'))
    }
    assert(protectedBodies.includes(current) && protectedBodies.includes(original.toString('utf8')), 'Restore did not protect both versions')
    result.currentOperation = 'surfaces: clean exit/reopen'; await persist()
    await closeApp(app, result); app = undefined
    app = await launch(executable, profile); page = await ready(app); await verifyIdentity(app, page, expectedVersion)
    await select(app, page, file, 'Package current B'); assert(await readFile(file, 'utf8') === current, 'Reopen changed restored/undone content')
    await capture(page, 'packaged-reopened-current.png'); await closeActive(page)
    assert(restorePageErrors.length === 0, 'Restore/undo raised renderer errors')
    result.surfaces = { sameTabLostReply: true, outline: true, historicalReadonly: true, exactByteExport: true, restore: true, undo: true, bothVersionsProtected: true, exitReopen: true, nativePickerAndConfirmation: 'controlled dialog boundaries; production filesystem and sandbox', nativePresentation: 'separate one-attempt phase' }
  } finally { if (app) await closeApp(app, result); await persist() }
}

export async function verifyPackagedMac({ appPath, fixtureRoot, evidenceDirectory, output, expectedVersion, phase = 'all', startupSamples = 30 }) {
  assert(Number.isSafeInteger(startupSamples) && startupSamples >= 1 && startupSamples <= 30, 'startupSamples must be 1..30')
  assert(expectedVersion, 'Provide an independent expected version')
  assert(['all', 'startup', 'running', 'smoke', 'surfaces', 'native-presentation'].includes(phase), 'Unknown verification phase')
  // Never overwrite an earlier attempt or remove its profile/failure evidence.
  await mkdir(evidenceDirectory, { recursive: false })
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'inknest-0.0.3-packaged-')))
  const executable = join(appPath, 'Contents', 'MacOS', 'InkNest')
  const result = { schemaVersion: 2, expectedVersion, phase, workspace, startedAt: new Date().toISOString(), failures: [], cleanupFailures: [],
    startup: { endpoint: 'Host before fresh packaged process launch through visible welcome heading and enabled Open button; warm OS filesystem caches.', samplesMs: [], requiredCount: 30 },
    open: { endpoint: 'Before native-picker replacement/UI open action through exact selected path plus unique preview heading and two animation frames; each file is freshly opened and really closed.', samplesMs: [], requiredCount: 30 },
    input: { endpoint: 'Packaged CodeMirror insertText transaction dispatch through next animation frame, 100KiB source. Synthetic transactions, not OS IME.', samplesMs: [], requiredCount: 1000 },
    memory: { definition: 'Electron app.getAppMetrics workingSetSize KiB summed over app-owned processes; RSS/shared pages may be counted repeatedly. 100KiB unedited reading documents.', cyclesCompleted: 0 }, consoleErrors: [] }
  const persist = async () => {
    for (const name of ['startup', 'open', 'input']) result[name].summary = summarize(result[name].samplesMs, result[name].requiredCount)
    await writeFile(join(evidenceDirectory, 'incremental.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
  await persist()
  if (phase === 'all' || phase === 'startup') {
    for (let index = 0; index < startupSamples; index++) {
      const start = performance.now()
      let app
      result.currentOperation = `startup-${index + 1}: launch`
      await persist()
      try {
        app = await launch(executable, join(workspace, `startup-${index + 1}`))
        result.currentOperation = `startup-${index + 1}: welcome`
        await persist()
        const page = await ready(app)
        const elapsedMs = performance.now() - start
        result.identity = await verifyIdentity(app, page, expectedVersion)
        result.startup.samplesMs.push(elapsedMs)
      } catch (error) {
        result.failures.push({ operation: result.currentOperation, elapsedMs: performance.now() - start, error: String(error) })
        break
      } finally { if (app) await closeApp(app, result); await persist() }
    }
  }
  if (phase === 'all' || phase === 'running') {
    let app
    try {
      result.currentOperation = 'running: launch'; await persist()
      app = await launch(executable, join(workspace, 'running-profile'))
      const page = await ready(app)
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()) })
      result.identity = await verifyIdentity(app, page, expectedVersion)

      // Measure a genuinely fresh unedited single-document baseline before any input workload.
      const standard = await readFile(join(fixtureRoot, 'performance', 'standard-100KiB.md'), 'utf8')
      const paths = []
      for (let i = 0; i < 20; i++) {
        const path = join(workspace, `memory-${i + 1}.md`)
        await writeFile(path, standard.replace('InkNest fixed 100KiB performance sample', `Memory document ${String(i + 1).padStart(2, '0')}`.padEnd(39, ' ')))
        paths.push(path)
      }
      result.currentOperation = 'memory: 1/5/20 tabs'; await persist()
      await select(app, page, paths[0], 'Memory document 01')
      await page.waitForTimeout(3000)
      result.memory.freshSingleAfterThreeSecondIdle = await metrics(app, page); await persist()
      for (let i = 1; i < 20; i++) {
        await select(app, page, paths[i], `Memory document ${String(i + 1).padStart(2, '0')}`)
        if (i === 4 || i === 19) {
          await page.waitForTimeout(3000)
          result.memory[`tabs${i + 1}AfterThreeSecondIdle`] = await metrics(app, page); await persist()
        }
      }
      for (let i = 19; i >= 1; i--) await closeActive(page)
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', paths[0])
      result.currentOperation = 'memory: 100 real open/close cycles'; await persist()
      for (let i = 0; i < 100; i++) {
        await select(app, page, paths[1], 'Memory document 02')
        await expect(page.getByRole('tab')).toHaveCount(2)
        await closeActive(page)
        await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', paths[0])
        await expect(page.locator('.preview').getByRole('heading', { name: 'Memory document 01', exact: true })).toBeVisible()
        result.memory.cyclesCompleted++; if (i % 10 === 9) await persist()
      }
      await page.waitForTimeout(30000)
      result.memory.singleAfterCyclesAndThirtySecondIdle = await metrics(app, page)
      result.memory.growthKiB = result.memory.singleAfterCyclesAndThirtySecondIdle.summedWorkingSetSizeKiB - result.memory.freshSingleAfterThreeSecondIdle.summedWorkingSetSizeKiB
      await persist()
      await closeActive(page)

      result.currentOperation = 'open: 30 fresh files'; await persist()
      for (let i = 0; i < 30; i++) {
        const path = join(workspace, `open-${i}.md`)
        const heading = `Open measurement ${String(i).padStart(2, '0')}`
        await writeFile(path, standard.replace('InkNest fixed 100KiB performance sample', heading.padEnd(39, ' ')))
        const start = performance.now()
        await select(app, page, path, heading)
        result.open.samplesMs.push(performance.now() - start); await persist()
        await closeActive(page)
      }
      result.currentOperation = 'input: 1000 transactions'; await persist()
      const inputPath = join(workspace, 'input.md'); await writeFile(inputPath, standard)
      await select(app, page, inputPath, 'InkNest fixed 100KiB performance sample')
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('textbox', { name: 'Markdown 源码' }).focus()
      await page.keyboard.press('ControlOrMeta+Home')
      // Persist each 100 transactions so an interrupted later batch retains earlier samples.
      for (let batch = 0; batch < 10; batch++) {
        const data = await page.evaluate(async () => {
          const view = Reflect.get(document.querySelector('.cm-content'), 'cmTile').root.view
          const before = view.state.doc.length
          const samples = []
          for (let i = 0; i < 100; i++) {
            const start = performance.now()
            if (!document.execCommand('insertText', false, 'x')) throw new Error('insertText refused')
            await new Promise(resolve => requestAnimationFrame(resolve))
            samples.push(performance.now() - start)
          }
          return { samples, inserted: view.state.doc.length - before }
        })
        assert(data.inserted === 100, `Input batch inserted ${data.inserted}/100 characters`)
        result.input.samplesMs.push(...data.samples); await persist()
      }
      const marker = 'packaged-preview-complete-marker'
      await page.keyboard.insertText(`\n${marker}\n`)
      const previewStart = performance.now()
      await page.getByRole('button', { name: '预览', exact: true }).click()
      await expect(page.locator('.preview')).toContainText(marker)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
      result.input.preview = { endpoint: 'Host immediately before Edit→Preview button click through marker in mounted read preview and next frame; preview is unmounted during edit.', elapsedMs: performance.now() - previewStart }
      await expect.poll(() => readFile(inputPath, 'utf8')).toContain(marker)
      await closeActive(page); await persist()

      result.currentOperation = 'packaged smoke: autosave and tab lifecycle'; await persist()
      const smoke = join(workspace, 'smoke'); await cp(fixtureRoot, smoke, { recursive: true })
      const editable = join(smoke, 'docs', '中文 说明.md')
      const before = await stat(editable)
      await select(app, page, editable, '中文本机冒烟')
      const image = page.getByAltText('同目录 PNG')
      await expect.poll(() => image.evaluate(image => image.naturalWidth)).toBe(128)
      assert(await page.locator('.preview img').count() === 1, 'Blocked images entered preview')
      await page.waitForTimeout(1300)
      assert((await stat(editable)).mtimeMs === before.mtimeMs, 'Unedited open touched file')
      await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()]).then(bytes => writeFile(join(evidenceDirectory, 'packaged-reader.png'), Buffer.from(bytes)))
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('textbox', { name: 'Markdown 源码' }).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('自动保存验证\n')
      await expect.poll(() => readFile(editable, 'utf8')).toMatch(/^自动保存验证\n/u)
      await select(app, page, paths[0], 'Memory document 01')
      await select(app, page, editable)
      await expect(page.getByRole('tab')).toHaveCount(2)
      await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText('自动保存验证')
      await page.getByRole('textbox', { name: 'Markdown 源码' }).focus(); await page.keyboard.insertText('关闭保存验证\n')
      await closeActive(page)
      assert((await readFile(editable, 'utf8')).includes('关闭保存验证'), 'Dirty tab close did not save latest content')
      await closeActive(page)
      await expect(page.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
      result.smoke = { openedChinesePath: true, authorizedPngLoaded: true, blockedImages: true, noWriteWithoutEdit: true, autosave: true, duplicateOpenPreservedEditor: true, dirtyTabCloseSaved: true, lastTabWelcome: true, nativePicker: 'replacement only', nativeIME: 'not tested' }
      assert(result.consoleErrors.length === 0, 'Renderer console errors recorded')
    } catch (error) { result.failures.push({ operation: result.currentOperation, error: String(error) }) }
    finally { if (app) await closeApp(app, result); await persist() }
  }
  if (phase === 'smoke') {
    try { await focusedFlows(executable, workspace, fixtureRoot, expectedVersion, result, persist) }
    catch (error) { result.failures.push({ operation: result.currentOperation, error: String(error) }) }
  }
  if (phase === 'surfaces' || phase === 'native-presentation') {
    try { await surfaceFlows(executable, workspace, expectedVersion, evidenceDirectory, result, persist, phase === 'native-presentation') }
    catch (error) { result.failures.push({ operation: result.currentOperation, error: String(error) }) }
  }
  result.finishedAt = new Date().toISOString()
  result.status = result.failures.length || result.cleanupFailures.length ? 'incomplete' : 'completed'
  await persist()
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/u, ''), process.argv[3 + i * 2]]))
  const result = await verifyPackagedMac({ appPath: resolve(args.app), fixtureRoot: resolve(args.fixtures), evidenceDirectory: resolve(args['evidence-dir']), output: resolve(args.output), expectedVersion: args['expected-version'], phase: args.phase, startupSamples: Number(args['startup-samples'] ?? 30) })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status !== 'completed') process.exitCode = 1
}
