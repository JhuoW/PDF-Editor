import { Buffer } from 'node:buffer';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';

async function open(page: Page) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([400, 600]);
  sheet.drawText('Editable paragraph for the review', { x: 35, y: 460, size: 14 });
  sheet.drawText('Rotated margin', { x: 15, y: 160, size: 10, rotate: degrees(90) });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'workspace-audit.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`welcome tasks remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('./');
    const create = page.getByRole('button', { name: 'Create PDFs from images', exact: true });
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeInViewport();
    const bounds = (await create.boundingBox())!, region = (await page.locator('.main-content').boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(region.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(region.y + region.height + 1);
    await create.click(); await expect(page.getByRole('dialog')).toBeVisible();
  });
}
test('phone edit mode explains its scope and keeps completion controls outside the scrollable tools', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  await page.locator('.workspace-ribbon [data-command=edit-text]').click();
  await expect(page.locator('.text-block.readonly')).not.toHaveCount(0);
  await expect(page.locator('.text-edit-readonly')).toHaveCount(0);
  await expect(page.locator('.edit-mode-description')).toContainText('Paragraph editing');
  const done = page.getByRole('button', { name: 'Done', exact: true });
  const ribbon = (await page.locator('.workspace-ribbon').boundingBox())!, button = (await done.boundingBox())!;
  expect(button.y).toBeGreaterThanOrEqual(ribbon.y + ribbon.height);
  await expect(done).toBeInViewport();
  await page.locator('.main-toolbar .language-switcher [lang=zh-CN]').click();
  await expect(page.locator('.edit-mode-description')).toContainText('段落编辑');
  await page.locator('.workspace-modebar').getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.workspace-ribbon [data-command=edit-objects]').click();
  await expect(page.locator('.edit-mode-description')).toContainText('单行文字独立');
});
test('an export failure keeps the PDF visible and does not suggest text checks for an image problem', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await open(page);
  await page.route(/PDFExport\.worker/, route => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage=()=>self.postMessage({type:"error",message:"Unsupported image format image/webp"})' }));
  const canvas = page.locator('canvas.page-canvas'), before = (await canvas.boundingBox())!;
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const error = page.locator('.error-state'); await expect(error).toBeVisible();
  await expect(canvas).toBeInViewport();
  expect((await canvas.boundingBox())!.width).toBeCloseTo(before.width, 1);
  await expect(error.getByRole('button', { name: 'Check text', exact: true })).toHaveCount(0);
  await error.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(error).toHaveCount(0);
  await page.unroute(/PDFExport\.worker/);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await downloaded;
  await expect(page.locator('.file-action-status')).toContainText('Downloaded copy');
});
