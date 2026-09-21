import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

let profile: string
test.beforeEach(async () => { profile = await mkdtemp(join(tmpdir(), 'inknest-window-profile-')) })
test.afterEach(async () => { await rm(profile, { recursive: true, force: true }) })

test('launches the production shell with an isolated renderer', async () => {
  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })

  try {
    const window = await electronApp.firstWindow()

    await expect(window).toHaveTitle('InkNest')
    await expect(window.getByRole('heading', { name: '打开一份文档' })).toBeVisible()

    const rendererBoundary = await window.evaluate(() => ({
      bridgeKeys: Object.keys(window.inknest),
      bridgeIsFrozen: Object.isFrozen(window.inknest),
      hasNodeRequire: typeof Reflect.get(window, 'require') !== 'undefined',
      csp: document.querySelector<HTMLMetaElement>(
        'meta[http-equiv="Content-Security-Policy"]'
      )?.content
    }))

    expect(rendererBoundary.csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/]{32}'/u)
    expect(rendererBoundary).toMatchObject({
      bridgeKeys: ['createDocument', 'openDocumentLink', 'getTheme', 'setTheme', 'setPresentation', 'checkpoint', 'listRecovery', 'inspectRecovery', 'restoreRecovery', 'discardRecovery', 'listHistory', 'inspectHistory', 'restoreHistory', 'exportHistory', 'clearRecords', 'saveAs', 'reconcileExternal', 'resolveConflict', 'save', 'openFile', 'rendererReady', 'closeDocument', 'activateDocument', 'completeClose', 'onEvent', 'resolveResources'],
      bridgeIsFrozen: true,
      hasNodeRequire: false,

    })

    const webPreferences = await electronApp.evaluate(({ BrowserWindow }) => {
      const [mainWindow] = BrowserWindow.getAllWindows()
      if (!mainWindow) throw new Error('Main window was not created')

      const preferences = mainWindow.webContents.getLastWebPreferences()
      return {
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        sandbox: preferences.sandbox,
        webSecurity: preferences.webSecurity
      }
    })

    expect(webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })

    const sandboxLaunch = await electronApp.evaluate(({ app }) => ({
      noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
      disableSandboxSwitch: app.commandLine.hasSwitch('disable-sandbox')
    }))
    expect(sandboxLaunch).toEqual({ noSandboxSwitch: false, disableSandboxSwitch: false })
  } finally {
    await electronApp.close()
  }
})

test('ignores a hostile development URL in the production build', async () => {
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    chromiumSandbox: true,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: 'data:text/html,<title>Untrusted renderer</title>'
    }
  })

  try {
    const window = await electronApp.firstWindow()

    expect(window.url()).toBe('inknest://app/')
    await expect(window).toHaveTitle('InkNest')
    await expect(window.getByRole('heading', { name: '打开一份文档' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('denies renderer navigation, new windows, and notification permission', async () => {
  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], chromiumSandbox: true })

  try {
    const window = await electronApp.firstWindow()
    const originalUrl = window.url()

    const openedWindow = await window.evaluate(() => window.open('https://example.invalid'))
    expect(openedWindow).toBeNull()
    expect(electronApp.windows()).toHaveLength(1)

    await window.evaluate(() => {
      const link = document.createElement('a')
      link.href = 'https://example.invalid/navigation-attempt'
      link.textContent = 'leave app'
      document.body.append(link)
      link.click()
    })
    await window.waitForTimeout(100)
    expect(window.url()).toBe(originalUrl)

    const permissionStates = await window.evaluate(async () => {
      const status = await navigator.permissions.query({ name: 'notifications' })
      return {
        queried: status.state,
        requested: await Notification.requestPermission()
      }
    })
    expect(permissionStates).toEqual({ queried: 'denied', requested: 'denied' })
  } finally {
    await electronApp.close()
  }
})
