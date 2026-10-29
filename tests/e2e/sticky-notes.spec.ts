import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFRef } from 'pdf-lib';

async function fixture() {
  const document = await PDFDocument.create();
  document.addPage([600, 800]).drawText('NOTE EDITING FIXTURE', { x: 60, y: 700, size: 14 });
  return Buffer.from(await document.save());
}
async function notes(data: Uint8Array) {
  const document = await PDFDocument.load(data);
  const annotations = document.getPage(0).node.Annots();
  const result: { content: string; author: string; name: string; reply: boolean; rectangle: number[] }[] = [];
  const text = (object: PDFDict, key: string) => {
    const value = object.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
    return value?.decodeText() ?? '';
  };
  for (const ref of annotations?.asArray() ?? []) {
    const annotation = document.context.lookup(ref, PDFDict);
    if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
    const rectangle = annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(number => (number as PDFNumber).asNumber());
    result.push({ content: text(annotation, 'Contents'), author: text(annotation, 'T'), name: text(annotation, 'NM'), reply: annotation.get(PDFName.of('IRT')) instanceof PDFRef, rectangle });
  }
  return result;
}
async function open(page: Page, bytes: Buffer, first = false) {
  if (first) await page.goto('/');
  const old = first ? null : await page.locator('canvas.page-canvas').elementHandle();
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: bytes });
  if (old) await old.waitForElementState('hidden');
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}
async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function selectNote(page: Page, rectangle: number[]) {
  await page.getByTitle('Select (V)', { exact: true }).click();
  const canvas = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + rectangle[0] * canvas.width / 600 + 6, canvas.y + (800 - rectangle[3]) * canvas.height / 800 + 6);
  await expect(page.getByRole('dialog', { name: /Note · Page 1/ })).toBeVisible();
}

test('native notes and replies remain editable after export and reopening, without duplicates', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await open(page, await fixture(), true);
  await page.getByTitle('Sticky Note', { exact: true }).click();
  const canvas = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 100, canvas.y + 140);
  const editor = page.getByRole('dialog', { name: /Note · Page 1/ });
  await expect(editor).toBeVisible();
  await page.getByRole('textbox', { name: 'Note author', exact: true }).fill('作者 Alice');
  await page.getByRole('textbox', { name: 'Note content', exact: true }).fill('待办：检查合同 — café');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('textbox', { name: 'New reply author', exact: true }).fill('回复者 Bob');
  await page.getByRole('textbox', { name: 'New reply content', exact: true }).fill('已检查，建议修改第二项。');
  await page.getByRole('button', { name: 'Add reply', exact: true }).click();
  const first = await download(page);
  const firstNotes = await notes(first);
  expect(firstNotes).toHaveLength(2);
  expect(firstNotes.find(note => !note.reply)).toMatchObject({ content: '待办：检查合同 — café', author: '作者 Alice' });
  expect(firstNotes.find(note => note.reply)).toMatchObject({ content: '已检查，建议修改第二项。', author: '回复者 Bob' });

  await open(page, first);
  await selectNote(page, firstNotes.find(note => !note.reply)!.rectangle);
  await expect(page.getByRole('textbox', { name: 'Note content', exact: true })).toHaveValue('待办：检查合同 — café');
  await expect(page.getByRole('textbox', { name: 'Reply 1 content', exact: true })).toHaveValue('已检查，建议修改第二项。');
  await page.getByRole('textbox', { name: 'Note content', exact: true }).fill('修订后的便签内容');
  await page.getByRole('textbox', { name: 'Reply 1 content', exact: true }).fill('回复已更新 ✓');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  const second = await download(page);
  const secondNotes = await notes(second);
  expect(secondNotes).toHaveLength(2);
  expect(secondNotes.find(note => !note.reply)?.content).toBe('修订后的便签内容');
  expect(secondNotes.find(note => note.reply)?.content).toBe('回复已更新 ✓');
  expect(secondNotes.map(note => note.name).sort()).toEqual(firstNotes.map(note => note.name).sort());
  expect(await notes(await download(page))).toEqual(secondNotes);

  await page.getByRole('textbox', { name: 'Note content', exact: true }).press('Escape');
  await expect(editor).toHaveCount(0);
  await selectNote(page, secondNotes.find(note => !note.reply)!.rectangle);
  await page.getByRole('button', { name: 'Delete reply 1', exact: true }).click();
  expect(await notes(await download(page))).toHaveLength(1);
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await notes(await download(page))).toHaveLength(0);
  await page.getByTitle('Undo Delete annotation (Ctrl+Z)', { exact: true }).click();
  expect(await notes(await download(page))).toHaveLength(1);
});
