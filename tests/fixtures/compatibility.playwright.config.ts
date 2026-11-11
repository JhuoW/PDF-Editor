import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Exercise native PDF rendering, editing workers, downloads and input handling
// in both non-Chromium engines without duplicating the entire regression suite.
export default defineConfig({
  testDir: fileURLToPath(new URL('../e2e', import.meta.url)),
  testMatch: ['review-audit-workspace.spec.ts', 'review-form-image-fidelity.spec.ts', 'chinese-fonts-search.spec.ts', 'inline-text-edit.spec.ts'],
  workers: 2,
  timeout: 60_000,
  projects: [{ name: 'firefox', use: { browserName: 'firefox' } }, { name: 'webkit', use: { browserName: 'webkit', launchOptions: { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH } } }],
  use: {
    baseURL: 'http://127.0.0.1:4177/PDF-Editor/',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite build --base=/PDF-Editor/ --outDir=node_modules/.tmp/pdf-editor-compatibility && npx vite preview --base=/PDF-Editor/ --outDir=node_modules/.tmp/pdf-editor-compatibility --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177/PDF-Editor/', reuseExistingServer: false, timeout: 120_000,
  },
});
