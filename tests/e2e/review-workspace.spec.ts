import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function open(page: Page) {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'workspace-review.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}

test('stamp selection returns keyboard focus to the entry that opened its menu', async ({ page }) => {
  await open(page); await page.locator('#workspace-annotate').click();
  const railTrigger = page.locator('.quick-tools [data-toolbar-menu-trigger="stamp"]');
  const ribbonTrigger = page.locator('.workspace-ribbon [data-toolbar-menu-trigger="stamp"]');
  for (const trigger of [railTrigger, ribbonTrigger]) {
    await trigger.focus(); await trigger.press('ArrowDown');
    const approved = page.locator('[data-toolbar-menu="stamp"]').getByRole('button', { name: 'Approved', exact: true });
    await expect(approved).toBeFocused(); await approved.press('Enter');
    await expect(page.locator('[data-toolbar-menu="stamp"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('closing the properties panel returns focus to its visible toggle', async ({ page }) => {
  await open(page);
  const toggle = page.getByRole('button', { name: 'Toggle properties', exact: true });
  await toggle.click(); const close = page.getByRole('button', { name: 'Close properties', exact: true });
  await close.focus(); await close.press('Enter');
  await expect(page.locator('.workspace-inspector')).toBeHidden();
  await expect(toggle).toBeFocused(); await toggle.press('Enter');
  await expect(page.locator('.workspace-inspector')).toBeVisible();
});

test('both language choices stay fully visible after opening a PDF on a 320px phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await open(page);
  const switcher = page.locator('.main-toolbar .language-switcher');
  for (const locale of ['zh-CN', 'en']) {
    const bounds = (await switcher.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await switcher.locator(`button[lang="${locale}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
});

test('arrow keys switch property tabs without moving the selected text box', async ({ page }) => {
  await open(page); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.quick-tools [data-command="freetext"]').click();
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 180); await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 255, { steps: 5 }); await page.mouse.up();
  await page.locator('.tiptap-editor-content[contenteditable="true"]').fill('Property tab keyboard review');
  await page.locator('.quick-tools [data-command="select"]').click();
  await page.getByRole('button', { name: 'Toggle properties', exact: true }).click();
  const panel = page.locator('.workspace-inspector'), text = panel.getByRole('tab', { name: 'Text', exact: true }), box = panel.getByRole('tab', { name: 'Box', exact: true });
  await box.click();
  const position = await panel.locator('.position-field input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  await text.click();
  const undo = page.locator('.workspace-history > button').first(), before = await undo.getAttribute('aria-label');
  await text.focus(); await text.press('ArrowRight');
  await expect(box).toHaveAttribute('aria-selected', 'true'); await expect(box).toBeFocused();
  await expect(undo).toHaveAttribute('aria-label', before!);
  expect(await panel.locator('.position-field input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(position);
  await box.press('Home'); await expect(text).toHaveAttribute('aria-selected', 'true'); await expect(text).toBeFocused();
});


test('properties become available when a PDF is open and do not expose a missing panel on the welcome screen', async ({ page }) => {
  await page.goto('./');
  const toggle = page.getByRole('button', { name: 'Toggle properties', exact: true });
  await expect(toggle).toBeDisabled(); await expect(toggle).not.toHaveAttribute('aria-controls', 'workspace-inspector-root');
  await open(page); await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(page.locator('#workspace-inspector-root')).toBeVisible();
});
