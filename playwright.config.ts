import { randomUUID } from 'node:crypto'
import { defineConfig } from '@playwright/test'

// Playwright sets FORCE_COLOR for its workers; keep a single color policy.
delete process.env.NO_COLOR
// Workers reload this config; inherit the runner ID instead of generating a second root.
const outputRunId = process.env.INKNEST_E2E_OUTPUT_RUN_ID ??= randomUUID()

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './scripts/playwright-teardown.mjs',
  // Keep evidence from earlier invocations; outputPath creates each test's directory.
  outputDir: `./test-results/run-${outputRunId}`,
  workers: 1
})
