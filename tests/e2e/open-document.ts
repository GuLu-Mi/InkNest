import type { Page } from '@playwright/test'

/** Open remains available on the home page and through the platform shortcut. */
export async function openDocumentPicker(page: Page): Promise<void> {
  await page.locator('.open-tab').waitFor({ state: 'visible' })
  if (await page.locator('.welcome-open').isVisible()) await page.locator('.welcome-open').click()
  else await page.keyboard.press('ControlOrMeta+o')
}
