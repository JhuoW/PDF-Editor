import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

async function openPDF(page: Page) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 650]); pdf.addPage([500, 650]);
  sheet.drawText('Original PDF content stays in English.', { x: 40, y: 550, size: 16 });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Keep this document value');
  field.addToPage(sheet, { x: 40, y: 440, width: 250, height: 25 });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'dialog-review.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Keep this document value');
}
async function tool(page: Page, id: string) {
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  await page.locator(`.workspace-all-tools [data-command="${id}"]`).click();
}

test('confirmation uses a true modal, contains focus through language changes and restores the opener', async ({ page }) => {
  await openPDF(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Unexported draft');
  await tool(page, 'close');
  const dialog = page.getByRole('dialog', { name: 'Close Document?', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const bounds = (await dialog.locator('.confirmation-dialog').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 8);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Close Without Saving', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await dialog.evaluate(element => {
    document.querySelector<HTMLButtonElement>('.main-toolbar .toolbar-btn-primary')!.focus();
    return element.contains(document.activeElement);
  })).toBe(true);
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await dialog.locator('.language-switcher button[lang="zh-CN"]').click();
  const localized = page.locator('dialog.confirmation-dialog-overlay');
  await expect(localized.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await expect(localized.locator('.confirmation-dialog-title')).not.toContainText('Close');
  expect(await localized.evaluate(element => element.matches(':modal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(localized).toHaveCount(0);
  await expect(page.locator('[data-toolbar-menu-trigger="document"]')).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Unexported draft');
});

test('page decoration validation changes language with an unfinished watermark and invalid range', async ({ page }) => {
  await openPDF(page); await tool(page, 'appearance');
  const dialog = page.locator('dialog.page-decorations-dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  const text = dialog.getByRole('textbox', { name: 'Watermark text', exact: true });
  await text.fill('Keep this English watermark');
  const range = dialog.locator('input[placeholder="1, 3-5"]'); await range.fill('3-1');
  const alert = dialog.getByRole('alert'); await expect(alert).toContainText(/[A-Za-z]/);
  await dialog.locator('.language-switcher button[lang="zh-CN"]').click();
  await expect(alert).toContainText(/[\u3400-\u9fff]/); await expect(alert).not.toContainText(/range|page|Invalid/);
  await expect(dialog.locator('textarea')).toHaveValue('Keep this English watermark');
  await expect(range).toHaveValue('3-1');
  await dialog.locator('.language-switcher button[lang="en"]').click();
  await expect(alert).toContainText(/[A-Za-z]/);
  await expect(text).toHaveValue('Keep this English watermark');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.textLayer').first()).toContainText('Original PDF content stays in English.');
});


test('native link hints switch immediately while preserving link nodes, descriptions, URLs and destinations', async ({ page }) => {
  const pdf = await PDFDocument.create(), first = pdf.addPage([500, 650]), second = pdf.addPage([500, 650]);
  first.drawText('Original link content stays in English.', { x: 40, y: 550, size: 16 });
  const internal = (left: number, description?: string) => pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [left, 400, left + 100, 425], Dest: [second.ref, 'Fit'],
    ...(description ? { Contents: PDFString.of(description) } : {}),
  }));
  const external = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 350, 180, 375],
    Contents: PDFString.of('Close'), A: { S: 'URI', URI: PDFString.of('https://example.com/Open') } }));
  first.node.set(PDFName.of('Annots'), pdf.context.obj([internal(40), internal(200, 'Open'), external]));
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'link-language.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  const links = page.locator('.pdf-link-annotation'); await expect(links).toHaveCount(3);
  const destination = links.nth(0), custom = links.nth(1), web = links.nth(2);
  await expect(destination).toHaveAttribute('title', 'Go to destination');
  await expect(destination).toHaveAttribute('aria-label', 'Go to destination');
  const originalNode = await destination.elementHandle(); await destination.focus();
  await page.locator('.main-toolbar .language-switcher button[lang="zh-CN"]').click();
  await expect(destination).not.toHaveAttribute('title', 'Go to destination');
  await expect(destination).toHaveAttribute('aria-label', /[\u3400-\u9fff]/);
  await expect(destination).toBeFocused(); expect(await originalNode!.evaluate(node => node.isConnected)).toBe(true);
  await expect(custom).toHaveAttribute('aria-label', 'Open');
  await expect(web).toHaveAttribute('aria-label', 'Close');
  await expect(web).toHaveAttribute('title', 'https://example.com/Open');
  await expect(web).toHaveAttribute('href', 'https://example.com/Open');
  await page.locator('.main-toolbar .language-switcher button[lang="en"]').click();
  await expect(destination).toHaveAttribute('title', 'Go to destination');
  await expect(destination).toHaveAttribute('aria-label', 'Go to destination');
  await expect(destination).toBeFocused();
  await destination.click(); await expect(page.locator('.page-input')).toHaveValue('2');
});
