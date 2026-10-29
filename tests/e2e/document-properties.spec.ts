import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';

const keptBytes = Buffer.from([0, 1, 2, 65, 255]);
const removedBytes = Buffer.from('remove me\n');
const addedBytes = Buffer.from([80, 68, 70, 0, 250, 10, 13, 255]);
const sharedName = 'same-name.bin';

async function fixture() {
  const document = await PDFDocument.create();
  document.addPage([400, 600]).drawText('Properties and attachments fixture', { x: 30, y: 550, size: 14 });
  document.setTitle('Original title');
  document.setAuthor('Original author');
  document.setSubject('Original subject');
  document.setKeywords(['original', 'keywords']);
  const xmp = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Stale XMP title</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  document.catalog.set(PDFName.of('Metadata'), document.context.register(document.context.flateStream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  const entries = [[keptBytes, 'Keep this attachment'], [removedBytes, 'Remove this attachment']] as const;
  const names = document.context.obj([]);
  for (const [index, [bytes, description]] of entries.entries()) {
    const stream = document.context.register(document.context.flateStream(bytes, {
      Type: 'EmbeddedFile', Subtype: PDFName.of('application/octet-stream'), Params: { Size: bytes.length },
    }));
    const specification = document.context.register(document.context.obj({
      Type: 'Filespec', F: PDFString.of(sharedName), UF: PDFHexString.fromText(sharedName),
      Desc: PDFHexString.fromText(description), EF: { F: stream, UF: stream },
    }));
    names.push(PDFString.of(`unique-key-${index}`));
    names.push(specification);
  }
  document.catalog.set(PDFName.of('Names'), document.context.obj({ EmbeddedFiles: { Names: names } }));
  return Buffer.from(await document.save());
}

async function openProperties(page: Page) {
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: 'Document Properties & Attachments…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document Properties & Attachments', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Document title', exact: true })).toBeEnabled();
  return dialog;
}

async function download(page: Page, start: () => Promise<unknown>) {
  const ready = page.waitForEvent('download');
  await start();
  const downloaded = await ready;
  const stream = await downloaded.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { name: downloaded.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

async function inspectPDF(bytes: Buffer) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const attachments: Array<{ name: string; description: string; bytes: Buffer }> = [];
  const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const visit = (node: PDFDict) => {
    const children = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    children?.asArray().forEach(child => visit(document.context.lookup(child, PDFDict)));
    const entries = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let index = 1; entries && index < entries.size(); index += 2) {
      const specification = entries.lookup(index, PDFDict);
      const name = specification.lookup(PDFName.of('UF'), PDFString, PDFHexString).decodeText();
      const description = specification.lookupMaybe(PDFName.of('Desc'), PDFString, PDFHexString)?.decodeText() ?? '';
      const stream = specification.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream);
      attachments.push({ name, description, bytes: Buffer.from(decodePDFRawStream(stream).decode()) });
    }
  };
  if (names) visit(names);
  // pdf-lib's metadata getters create an empty Info dictionary when absent.
  // Check the parsed trailer before invoking those getters.
  const hasInfo = document.context.trailerInfo.Info !== undefined;
  return {
    title: document.getTitle(), author: document.getAuthor(), subject: document.getSubject(), keywords: document.getKeywords(),
    hasInfo, hasXmp: document.catalog.has(PDFName.of('Metadata')),
    attachments: attachments.sort((a, b) => a.description.localeCompare(b.description)),
  };
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('edits metadata and manages same-name attachments with exact downloads, undo and refresh', async ({ page }) => {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'document-assets.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  let dialog = await openProperties(page);
  await expect(dialog.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue('Original title');
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  await expect(dialog).toContainText('This document contains XMP metadata.');
  const keptRow = dialog.getByRole('row').filter({ hasText: 'Keep this attachment' });
  const originalDownload = await download(page, () => keptRow.getByRole('button', { name: /^Download attachment/ }).click());
  expect(originalDownload.name).toBe(sharedName);
  expect(originalDownload.bytes).toEqual(keptBytes);

  // Selecting an attachment first must survive the PDF revision change caused
  // by saving properties; neither draft should silently disappear.
  await dialog.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: sharedName, mimeType: 'application/octet-stream', buffer: addedBytes });
  await dialog.getByLabel('Attachment description', { exact: true }).fill('Added from browser');
  for (const [field, value] of Object.entries({ title: '编辑后的标题', author: '作者 Alice', subject: 'Edited subject', keywords: '中文, tests' })) {
    await dialog.getByRole('textbox', { name: `Document ${field}`, exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: 'Save properties', exact: true }).click();
  await expect(dialog).toContainText('Document properties saved.');
  await expect(dialog).not.toContainText('This document contains XMP metadata.');
  await expect(dialog.getByLabel('Attachment description', { exact: true })).toHaveValue('Added from browser');
  await expect(dialog.getByRole('button', { name: 'Add attachment', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add attachment', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
  await dialog.getByRole('row').filter({ hasText: 'Remove this attachment' }).getByRole('button', { name: /^Delete attachment/ }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  await expect(dialog).toContainText('Keep this attachment');
  await expect(dialog).toContainText('Added from browser');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const exported = await inspectPDF((await download(page, () => page.getByRole('button', { name: 'Export', exact: true }).click())).bytes);
  expect(exported).toMatchObject({ title: '编辑后的标题', author: '作者 Alice', subject: 'Edited subject', keywords: '中文, tests', hasXmp: false });
  expect(exported.attachments).toEqual([
    { name: sharedName, description: 'Added from browser', bytes: addedBytes },
    { name: sharedName, description: 'Keep this attachment', bytes: keptBytes },
  ]);

  await page.getByTitle('Undo Remove attachment (Ctrl+Z)', { exact: true }).click();
  await expect(page.getByTitle('Redo Remove attachment (Ctrl+Shift+Z)', { exact: true })).toBeEnabled();
  dialog = await openProperties(page);
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
  await expect(dialog.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue('编辑后的标题');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  dialog = await openProperties(page);
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
  await expect(dialog.getByRole('textbox', { name: 'Document author', exact: true })).toHaveValue('作者 Alice');
  const addedDownload = await download(page, () => dialog.getByRole('row').filter({ hasText: 'Added from browser' }).getByRole('button', { name: /^Download attachment/ }).click());
  expect(addedDownload.bytes).toEqual(addedBytes);

  await dialog.getByRole('button', { name: 'Clear document metadata', exact: true }).click();
  for (const field of ['title', 'author', 'subject', 'keywords']) await expect(dialog.getByRole('textbox', { name: `Document ${field}`, exact: true })).toHaveValue('');
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const cleared = await inspectPDF((await download(page, () => page.getByRole('button', { name: 'Export', exact: true }).click())).bytes);
  expect(cleared.hasInfo).toBe(false);
  expect(cleared.hasXmp).toBe(false);
  expect(cleared.attachments).toEqual([
    { name: sharedName, description: 'Added from browser', bytes: addedBytes },
    { name: sharedName, description: 'Keep this attachment', bytes: keptBytes },
    { name: sharedName, description: 'Remove this attachment', bytes: removedBytes },
  ]);
  await page.getByTitle('Undo Clear document metadata (Ctrl+Z)', { exact: true }).click();
  dialog = await openProperties(page);
  await expect(dialog.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue('编辑后的标题');
});
