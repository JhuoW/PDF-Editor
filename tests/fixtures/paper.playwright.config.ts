import process from 'node:process';
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Manual real-document regression. Download the paper separately and pass
// PDF_EDITOR_PAPER_PATH; third-party PDFs are not stored in this repository.
export default defineConfig({
  testDir: fileURLToPath(new URL('../manual', import.meta.url)),
  testMatch: 'paper-text-edit.spec.ts',
  outputDir: fileURLToPath(new URL('../../node_modules/.tmp/paper-test-results', import.meta.url)),
  workers: 1,
  timeout: 120_000,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4187',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite build --outDir=node_modules/.tmp/pdf-editor-paper-test && npx vite preview --outDir=node_modules/.tmp/pdf-editor-paper-test --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
