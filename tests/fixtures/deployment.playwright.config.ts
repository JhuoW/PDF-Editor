import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: fileURLToPath(new URL('../e2e', import.meta.url)),
  testMatch: ['text-extremes.spec.ts', 'object-extreme.spec.ts', 'text-mode-behavior.spec.ts', 'font-visual-roundtrip.spec.ts', 'type1-text-edit.spec.ts', 'paragraph-object-modes.spec.ts', 'chinese-fonts-search.spec.ts', 'update-history.spec.ts', 'reliability.spec.ts', 'save-crop-lifecycle.spec.ts', 'new-features-regression.spec.ts', 'page-management.spec.ts', 'pdf-to-images.spec.ts', 'conversion.spec.ts', 'advanced-editing.spec.ts', 'object-editing.spec.ts', 'review-*.spec.ts', 'workspace-i18n.spec.ts', 'deployment.spec.ts', 'inline-text-edit.spec.ts', 'text-fidelity.spec.ts', 'paragraph-reflow.spec.ts', 'bookmarks.spec.ts', 'signature.spec.ts', 'drawing-coordinates.spec.ts', 'image-insertion.spec.ts', 'custom-stamps.spec.ts', 'search-navigation.spec.ts', 'ui-final-review.spec.ts', 'interaction-guards.spec.ts'],
  workers: 1,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4176/PDF-Editor/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite build --base=/PDF-Editor/ --outDir=node_modules/.tmp/pdf-editor-deployment && npx vite preview --base=/PDF-Editor/ --outDir=node_modules/.tmp/pdf-editor-deployment --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176/PDF-Editor/',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
