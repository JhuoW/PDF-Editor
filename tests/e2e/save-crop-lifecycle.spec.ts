import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';

async function fixture(rotation = 0) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([400, 600]);
  sheet.setRotation(degrees(rotation)); sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  sheet.drawText('Keep this original content', { x: 50, y: 400, size: 16 });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original'); field.addToPage(sheet, { x: 50, y: 300, width: 200, height: 25 });
  return Buffer.from(await pdf.save());
}
async function open(page: Page, rotation = 0) {
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: await fixture(rotation) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.document-title')).not.toContainText('*');
}
async function command(page: Page, id: string) {
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  await page.locator(`.workspace-all-tools [data-command="${id}"]`).click();
}
async function draw(page: Page) {
  await command(page, 'crop-pages'); const layer = page.locator('.page-crop-layer'); await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;
  await page.mouse.move(box.x + box.width * .1, box.y + box.height * .2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.page-crop-selection')).toBeVisible(); return layer;
}
async function bytes(page: Page) {
  const pending = page.waitForEvent('download'); await page.locator('.main-toolbar .toolbar-btn-primary').click();
  return readFile((await (await pending).path())!);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); localStorage.setItem('pdf-editor.locale', 'en'); });
});

for (const rotation of [0, 90]) test(`draws a real crop and applies with Enter or Confirm on Rotate${rotation}/UserUnit2`, async ({ page }) => {
  await open(page, rotation); const layer = await draw(page);
  if (rotation) await page.getByRole('button', { name: 'Confirm crop', exact: true }).click(); else await layer.press('Enter');
  await expect(layer).toHaveCount(0);
  const pdf = await PDFDocument.load(await bytes(page)), box = pdf.getPage(0).getCropBox();
  expect(box.width / 400).toBeCloseTo(rotation ? .5 : .6, 2); expect(box.height / 600).toBeCloseTo(rotation ? .6 : .5, 2);
  expect(box.x / 400).toBeCloseTo(rotation ? .2 : .1, 2); expect(box.y / 600).toBeCloseTo(rotation ? .1 : .3, 2);
  await page.locator('.workspace-history > button').first().click();
  await expect.poll(async () => (await PDFDocument.load(await bytes(page))).getPage(0).getCropBox()).toEqual({ x: 0, y: 0, width: 400, height: 600 });
});

test('cancels a drawn crop without changing the PDF and opens batch margin settings', async ({ page }) => {
  await open(page); await draw(page); await page.keyboard.press('Escape');
  await expect(page.locator('.page-crop-layer')).toHaveCount(0); await expect(page.locator('.document-title')).not.toContainText('*');
  await draw(page); await page.locator('[data-crop-action="options"]').click();
  const dialog = page.getByRole('dialog', { name: 'Crop pages', exact: true }); await expect(dialog).toBeVisible();
  expect(Number(await dialog.getByLabel('Top margin (mm)', { exact: true }).inputValue())).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await PDFDocument.load(await bytes(page))).getPage(0).getCropBox()).toEqual({ x: 0, y: 0, width: 400, height: 600 });
});

test('Save reuses the selected destination and Save As always selects a new destination', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    Reflect.set(window, '__writes', []); Reflect.set(window, '__picks', 0);
    Reflect.set(window, 'showSaveFilePicker', async () => {
      const count = Reflect.get(window, '__picks') + 1; Reflect.set(window, '__picks', count);
      const name = count === 1 ? 'saved.pdf' : 'copy.pdf';
      return { name, createWritable: async () => ({ write: async (data: Uint8Array) => Reflect.get(window, '__writes').push({ name, bytes: [...data] }), close: async () => {} }) };
    });
  });
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('First save');
  await page.locator('.toolbar-save-button').click(); await expect(page.locator('.document-title')).toHaveText('saved.pdf');
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Second save');
  await page.keyboard.press('Control+s'); await expect(page.locator('.document-title')).toHaveText('saved.pdf');
  await page.keyboard.press('Control+Shift+s'); await expect(page.locator('.document-title')).toHaveText('copy.pdf');
  const result = await page.evaluate(() => ({ picks: Reflect.get(window, '__picks'), writes: Reflect.get(window, '__writes') }));
  expect(result.picks).toBe(2); expect(result.writes).toHaveLength(3);
  expect(result.writes.map((entry: { name: string }) => entry.name)).toEqual(['saved.pdf', 'saved.pdf', 'copy.pdf']);
  for (const [index, entry] of result.writes.entries()) {
    const pdf = await PDFDocument.load(new Uint8Array(entry.bytes)); expect(pdf.getForm().getTextField('Contact').getText()).toBe(index ? 'Second save' : 'First save');
  }
});

test('cancelled Save keeps the close prompt and draft; saving from the prompt closes only after a successful write', async ({ page }) => {
  await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Unsaved'); await command(page, 'close');
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true }); await expect(dialog).toBeVisible();
  await page.evaluate(() => Reflect.set(window, 'showSaveFilePicker', async () => { throw new DOMException('Cancelled', 'AbortError'); }));
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Unsaved');
  await command(page, 'close');
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'));
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const output = await pending, pdf = await PDFDocument.load(await readFile((await output.path())!)); expect(pdf.getForm().getTextField('Contact').getText()).toBe('Unsaved');
  await expect(page.getByRole('heading', { name: 'Open a PDF', exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('canvas.page-canvas')).toHaveCount(0);
});

test('a fresh tab starts empty without clearing another tab, while closing a dirty window warns about changes', async ({ page, context }) => {
  await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).click(); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Keep unsaved');
  const fresh = await context.newPage(); await fresh.goto('./'); await expect(fresh.getByRole('heading', { name: 'Open a PDF', exact: true })).toBeVisible(); await fresh.close();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Keep unsaved');
  const prompt = page.waitForEvent('dialog'); await page.close({ runBeforeUnload: true }); const warning = await prompt;
  expect(warning.type()).toBe('beforeunload'); await warning.accept();
  const reopened = await context.newPage(); await reopened.goto('./'); await expect(reopened.getByRole('heading', { name: 'Open a PDF', exact: true })).toBeVisible();
});

test('Export is translated as 导出 and Save As has a separate entry on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await open(page);
  await page.locator('.main-toolbar .language-switcher button[lang="zh-CN"]').click();
  await expect(page.locator('.main-toolbar .toolbar-btn-primary')).toHaveAccessibleName('导出');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  const menu = page.locator('.toolbar-file-actions'); await expect(menu.locator('[data-file-action="save"]')).toContainText('保存');
  await expect(menu.locator('[data-file-action="save-as"]')).toContainText('另存为'); await expect(menu.locator('[data-file-action="export"]')).toHaveText('导出');
  expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '/tmp/pdf-save-crop-phone.png' });
});

test('opening another file offers Cancel or discard and leaves the replacement clean', async ({ page }) => {
  await open(page);
  const contact = page.getByRole('textbox', { name: 'Contact', exact: true });
  await contact.fill('Keep this draft');
  const replacement = { name: 'replacement.pdf', mimeType: 'application/pdf', buffer: await fixture() };
  await page.locator('.main-toolbar input[type=file]').setInputFiles(replacement);
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(contact).toHaveValue('Keep this draft');
  await expect(page.locator('.document-title')).toHaveText('document.pdf *');
  await page.locator('.main-toolbar input[type=file]').setInputFiles(replacement);
  await dialog.getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect(page.locator('.document-title')).toHaveText('replacement.pdf');
  await expect(contact).toHaveValue('Original');
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
});

test('native Open keeps its file handle so Save writes the original file without a new picker', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(data => {
    Reflect.set(window, '__writes', []);
    Reflect.set(window, 'showOpenFilePicker', async () => [{
      name: 'native.pdf', getFile: async () => new File([new Uint8Array(data)], 'native.pdf', { type: 'application/pdf' }),
      queryPermission: async () => 'prompt', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async (bytes: Uint8Array) => Reflect.get(window, '__writes').push([...bytes]), close: async () => {} }),
    }]);
    Reflect.set(window, 'showSaveFilePicker', async () => { throw new Error('Save must reuse the open handle'); });
  }, [...await fixture()]);
  await page.locator('.main-toolbar').getByRole('button', { name: 'Open', exact: true }).click();
  const contact = page.getByRole('textbox', { name: 'Contact', exact: true });
  await contact.fill('Saved to original'); await page.keyboard.press('Control+s');
  await expect(page.locator('.document-title')).toHaveText('native.pdf');
  const writes: number[][] = await page.evaluate(() => Reflect.get(window, '__writes'));
  expect(writes).toHaveLength(1);
  expect((await PDFDocument.load(new Uint8Array(writes[0]))).getForm().getTextField('Contact').getText()).toBe('Saved to original');
});

test('edits made while a file is being written remain unsaved', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    Reflect.set(window, 'showSaveFilePicker', async () => ({ name: 'saved.pdf', createWritable: async () => ({
      write: (bytes: Uint8Array) => new Promise<void>(resolve => { Reflect.set(window, '__savedBytes', [...bytes]); Reflect.set(window, '__finishWrite', resolve); }),
      close: async () => {},
    }) }));
  });
  const contact = page.getByRole('textbox', { name: 'Contact', exact: true });
  await contact.fill('Snapshot'); await page.locator('.toolbar-save-button').click();
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, '__finishWrite'))).toBe('function');
  await contact.fill('Later edit');
  await page.evaluate(() => Reflect.get(window, '__finishWrite')());
  await expect(page.locator('.document-title')).toHaveText('saved.pdf *');
  const savedBytes: number[] = await page.evaluate(() => Reflect.get(window, '__savedBytes'));
  expect((await PDFDocument.load(new Uint8Array(savedBytes))).getForm().getTextField('Contact').getText()).toBe('Snapshot');
  await command(page, 'close'); await expect(page.getByRole('dialog', { name: 'Save changes?', exact: true })).toBeVisible();
});

test('download fallback Save As uses the chosen filename for subsequent saves and exports', async ({ page }) => {
  await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Renamed copy');
  page.once('dialog', dialog => dialog.accept('renamed'));
  const pending = page.waitForEvent('download'); await page.keyboard.press('Control+Shift+s');
  expect((await pending).suggestedFilename()).toBe('renamed.pdf');
  await expect(page.locator('.document-title')).toHaveText('renamed.pdf');
  const exported = page.waitForEvent('download'); await page.locator('.main-toolbar .toolbar-btn-primary').click();
  expect((await exported).suggestedFilename()).toBe('renamed.pdf');
});
