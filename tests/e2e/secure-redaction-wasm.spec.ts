import { test, expect } from '@playwright/test';

test('loads the WASM engine on demand and removes content in the browser', async ({ page }) => {
  const wasmRequests: string[] = [];
  const failures: string[] = [];
  page.on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/tests/fixtures/secure-redaction.html');
  await expect(page.locator('#result')).toHaveText('Ready; engine not loaded');
  expect(wasmRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Run content removal' }).click();
  await expect(page.locator('#result')).toContainText('PASS: PUBLIC_REMAINS', { timeout: 30000 });
  expect(wasmRequests).toHaveLength(1);
  expect(failures).toEqual([]);
});
