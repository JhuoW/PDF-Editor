import process from 'node:process';
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Opt-in: PDF_EDITOR_ARXIV_PATH=/tmp/pdf-editor-arxiv-attention.pdf
// npx playwright test --config=tests/fixtures/arxiv.playwright.config.ts
// The downloaded third-party paper is deliberately not committed.
export default defineConfig({
  testDir: fileURLToPath(new URL('../manual', import.meta.url)),
  testMatch: 'arxiv-text-edit.spec.ts',
  outputDir: fileURLToPath(new URL('../../node_modules/.tmp/arxiv-test-results', import.meta.url)),
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4193',
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite build --outDir=node_modules/.tmp/arxiv-test && npx vite preview --outDir=node_modules/.tmp/arxiv-test --host 127.0.0.1 --port 4193 --strictPort',
    url: 'http://127.0.0.1:4193',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
