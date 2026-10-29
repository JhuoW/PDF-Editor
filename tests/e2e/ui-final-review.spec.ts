import { Buffer } from 'node:buffer';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function openDocument(page: Page) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 3; index++) pdf.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'ui-review.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}

test('landscape document menu scrolls within the viewport and supports keyboard dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openDocument(page);
  const trigger = page.getByRole('button', { name: 'Document ▾', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.toolbar-menu');
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(382);
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const items = menu.locator('button:enabled');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
});

test('narrow form menu remains inside the screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openDocument(page);
  await page.getByRole('button', { name: /^Form.*▾$/ }).click();
  const menu = page.locator('.toolbar-menu');
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(312);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
});

test('phone reading starts at usable width and opening the sidebar does not shrink the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDocument(page);
  const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sidebar')).toHaveCount(0);
  const canvas = page.locator('canvas.page-canvas');
  const before = await canvas.boundingBox();
  expect(before!.width).toBeGreaterThan(250);
  await toggle.click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(before!.width);
  await toggle.click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
});

for (const [action, prefix] of [['Merge PDFs', 'merge'], ['Split PDF', 'split']] as const) {
  test(`${action} isolates keyboard input and keeps controls reachable in landscape`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openDocument(page);
    await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    const dialog = page.locator(`dialog.${prefix}-dialog-overlay`);
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      // Native dialogs may move focus to browser chrome at the end of the cycle,
      // reported as body; background editor controls must remain inaccessible.
      expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
    }
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
    const bounds = await page.locator(`.${prefix}-dialog`).boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(16);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(374);
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.locator(`.${prefix}-dialog-content`).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const close = page.locator(`.${prefix}-dialog-close`);
    await expect(close).toBeInViewport();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
}
