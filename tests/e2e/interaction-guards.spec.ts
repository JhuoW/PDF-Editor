import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function openPDF(page: Page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  pdf.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'interaction-guards.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

test('annotation arrows nudge without navigating and modal keys cannot change the annotation or history', async ({ page }) => {
  await openPDF(page);
  await page.getByTitle(/^Rectangle(?: \(R\))?$/).click();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 180, { steps: 4 });
  await page.mouse.up();
  await page.getByTitle('Select (V)', { exact: true }).click();
  const region = page.locator('.annotation-hit-regions rect');
  await expect(region).toHaveCount(1);
  const initialX = Number(await region.getAttribute('x'));
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('1');
  await expect.poll(async () => Number(await region.getAttribute('x'))).toBeCloseTo(initialX + 1);

  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Merge PDFs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Insert PDF Pages', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close merge dialog', exact: true }).focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+z');
  await expect(region).toHaveCount(1);
  await expect.poll(async () => Number(await region.getAttribute('x'))).toBeCloseTo(initialX + 1);
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Number(await region.getAttribute('x'))).toBeCloseTo(initialX);
});

test('Escape cancels remaining images and returns to selection after the first image is placed', async ({ page }) => {
  await openPDF(page);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><path fill="red" d="M0 0H30V20H0Z"/></svg>');
  await page.getByLabel('Insert images', { exact: true }).setInputFiles([
    { name: 'first.svg', mimeType: 'image/svg+xml', buffer: svg },
    { name: 'second.svg', mimeType: 'image/svg+xml', buffer: svg },
  ]);
  await expect(page.locator('.image-placement-status')).toContainText('first.svg');
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(box.x + 200, box.y + 250);
  await expect(page.locator('.image-placement-status')).toContainText('second.svg');
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-placement-status')).toHaveCount(0);
  await expect(page.getByTitle('Select (V)', { exact: true })).toHaveClass(/active/);
  await expect(page.locator('.drawing-annotation-layer')).not.toHaveClass(/drawing-mode/);
  await page.mouse.click(box.x + 280, box.y + 400);
  await expect(page.locator('.annotation-hit-regions rect')).toHaveCount(1);
});

test('the wheel scrolls an enlarged page in single and two-page views without changing pages', async ({ page }) => {
  await openPDF(page);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('2');
  const viewer = page.locator('.pdf-viewer-container');
  for (const view of ['Single page view', 'Two page view']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
    await viewer.evaluate(element => { element.scrollTop = 0; });
    await viewer.hover({ position: { x: 120, y: 180 } });
    await page.mouse.wheel(0, 180);
    await expect.poll(() => viewer.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
    await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('1');
  }
});

test('Escape cancels a pending merge dialog before a delayed PDF read completes', async ({ page }) => {
  await openPDF(page);
  await expect(page.getByText('Changes saved on this device', { exact: true })).toBeVisible();
  // Delay the real PDF worker request, so this also exercises production builds.
  await page.evaluate(() => {
    const state = window as Window & { mergeReadPaused?: boolean; releaseMergeRead?: () => Promise<void> };
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args: Parameters<Worker['postMessage']>) {
      const message = args[0];
      if (message?.action !== 'GetData') return send.apply(this, args);
      Worker.prototype.postMessage = send;
      state.mergeReadPaused = true;
      state.releaseMergeRead = () => new Promise(resolve => {
        const onResponse = (event: MessageEvent) => {
          if (event.data?.callbackId !== message.callbackId) return;
          this.removeEventListener('message', onResponse);
          resolve();
        };
        this.addEventListener('message', onResponse);
        send.apply(this, args);
      });
    };
  });
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Merge PDFs', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { mergeReadPaused?: boolean }).mergeReadPaused)).toBe(true);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await (window as Window & { releaseMergeRead: () => Promise<void> }).releaseMergeRead();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('dialog.merge-dialog-overlay')).toHaveCount(0);
  // A cancelled request must not prevent the next deliberate open.
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Merge PDFs', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Insert PDF Pages', exact: true })).toBeVisible();
});
