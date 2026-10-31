import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

test('shows only the latest update, expands dated history, switches language and restores focus', async ({ page }) => {
  await page.goto('./');
  const trigger = page.getByRole('button', { name: 'Update history', exact: true });
  await expect(trigger).toBeInViewport(); await trigger.click();
  const dialog = page.locator('.update-history-dialog'), entries = dialog.locator('.update-history-entry');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  const heading = await dialog.locator('h2').boundingBox(), closeButton = await dialog.locator('.update-history-close').boundingBox();
  expect(Math.abs(heading!.y - closeButton!.y)).toBeLessThan(12);
  expect(closeButton!.x).toBeGreaterThan(heading!.x + heading!.width);
  await expect(dialog.locator('.update-history-entry:visible')).toHaveCount(1);
  await expect(entries.first()).toContainText('Chinese fonts:');
  await expect(entries.first()).toContainText('Font compatibility:');
  await expect(entries.first()).toContainText('Search after editing:');
  const latestTime = await entries.first().locator('time').innerText();
  await expect(entries.first().locator('time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const toggle = dialog.locator('.update-history-toggle');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(entries.nth(1)).toContainText('Text checks:');
  await expect(entries.nth(1)).toContainText('Export and performance:');
  await expect(entries.nth(1)).toContainText('Diagnostics and recovery:');
  await expect(entries.nth(1)).toContainText('CI:');
  const dates = await entries.locator('time').evaluateAll(elements => elements.map(element => element.getAttribute('datetime')!));
  expect(dates.length).toBeGreaterThan(20);
  for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  const timestamps = dates.map(value => Date.parse(value));
  expect(timestamps.every(Number.isFinite)).toBe(true);
  expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  await dialog.locator('.language-switcher [lang=zh-CN]').click();
  await expect(dialog.getByRole('heading', { name: '历史更新', exact: true })).toBeVisible();
  await expect(entries.first()).toContainText('中文字体：');
  await expect(entries.first()).toContainText('编辑后搜索：');
  await expect(entries.nth(1)).toContainText('文字检查：新增“编辑 → 检查文字”');
  await expect(entries.nth(1)).toContainText('导出与性能：');
  await expect(entries.nth(1)).toContainText('错误诊断与恢复：');
  await expect(entries.last()).toContainText('建立 PDF Editor 初始项目');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(entries.first().locator('time')).toHaveText(latestTime);
  await toggle.click(); await expect(dialog.locator('.update-history-entry:visible')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  const chineseTrigger = page.getByRole('button', { name: '历史更新', exact: true });
  await expect(chineseTrigger).toBeFocused();
  await chineseTrigger.press('Enter');
  await expect(page.locator('.update-history-dialog .update-history-entry:visible')).toHaveCount(1);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 740, height: 360 }]) {
  test(`keeps update history scrollable and its controls reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('./');
    await page.getByRole('button', { name: 'Update history', exact: true }).click();
    const dialog = page.locator('.update-history-dialog');
    await dialog.locator('.language-switcher [lang=zh-CN]').click();
    const toggle = dialog.locator('.update-history-toggle'), close = dialog.getByRole('button', { name: '关闭', exact: true });
    await expect(toggle).toBeInViewport(); await expect(close).toBeInViewport();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await toggle.click();
    await dialog.locator('.update-history-entry').last().scrollIntoViewIfNeeded();
    await expect(dialog.locator('.update-history-entry').last()).toBeInViewport();
    expect(await dialog.locator('.update-history-content').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(toggle).toBeInViewport(); await expect(close).toBeInViewport();
    await toggle.click();
    await expect(dialog.locator('.update-history-entry').first()).toBeInViewport();
    expect(await dialog.locator('.update-history-content').evaluate(element => element.scrollTop)).toBe(0);
    await close.click(); await expect(dialog).toHaveCount(0);
  });
}

test('history and its keyboard controls preserve active text edits, form values and export', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const source = await PDFDocument.create(), sheet = source.addPage([500, 650]);
  sheet.drawText('Original history check', { x: 40, y: 550, size: 16 });
  const field = source.getForm().createTextField('Contact'); field.setText('Baseline'); field.addToPage(sheet, { x: 40, y: 100, width: 220, height: 25 });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'update-history.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Keep the form edit');
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  await page.locator('.workspace-ribbon').getByRole('button', { name: 'Edit text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original history check' }).click();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('History preserved 中文');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'History preserved 中文');
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Update history', exact: true }).click();
  await expect(page.locator('.update-history-dialog')).toBeVisible();
  for (const key of ['Control+z', 'Control+s', 'Delete', 'ArrowRight']) await page.keyboard.press(key);
  expect(downloads).toBe(0);
  await page.keyboard.press('Escape'); await expect(page.locator('.update-history-dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Keep the form edit');
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks), pdf = new mupdf.PDFDocument(bytes), pdfPage = pdf.loadPage(0), text = pdfPage.toStructuredText('');
  try { expect(text.asText()).toContain('History preserved 中文'); expect(text.asText()).not.toContain('Original history check'); }
  finally { text.destroy(); pdfPage.destroy(); pdf.destroy(); }
  expect((await PDFDocument.load(bytes)).getForm().getTextField('Contact').getText()).toBe('Keep the form edit');
});
