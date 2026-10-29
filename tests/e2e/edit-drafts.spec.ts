import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

const original = 'Original content with room for replacement';
const footer = 'UNCHANGED FOOTER';

async function openSource(page: Page) {
  const source = await PDFDocument.create();
  const pdfPage = source.addPage([400, 600]);
  pdfPage.drawText(original, { x: 30, y: 520, size: 12 });
  pdfPage.drawText(footer, { x: 30, y: 40, size: 12 });
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'live-edit-drafts.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
}

async function exportedText(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await ready).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const document = new mupdf.PDFDocument(Buffer.concat(chunks));
  try {
    const pdfPage = document.loadPage(0);
    const text = pdfPage.toStructuredText('');
    try {
      const content = text.asText();
      expect(content).toContain(footer);
      return content;
    } finally { text.destroy(); pdfPage.destroy(); }
  } finally { document.destroy(); }
}

async function historyStep(page: Page, direction: 'Undo' | 'Redo', action: string) {
  const button = page.getByRole('button', { name: `${direction} ${action}`, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('.loading-state')).toHaveCount(0);
}

function undo(page: Page) { return page.locator('.combined-toolbar button[title^="Undo"]'); }
function redo(page: Page) { return page.locator('.combined-toolbar button[title^="Redo"]'); }

async function startOriginalTextEdit(page: Page, content: string) {
  if (!(await page.locator('.text-block').count())) {
    await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
    await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  }
  await page.locator('.text-block').filter({ hasText: content }).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await expect(editor).toBeFocused();
  return editor;
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('text box drafts save while focused, undo as one edit, and export immediately', async ({ page }) => {
  await openSource(page);
  await page.getByTitle('Text Box', { exact: true }).click();
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 340, bounds.y + 280, { steps: 5 });
  await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable="true"]');
  await expect(editor).toBeFocused();
  await expect(undo(page)).toHaveAccessibleName('Undo Add annotation');
  const draft = 'Draft note saved while focused';
  // Multiple actual keystrokes must form one history entry, separate from creation.
  await editor.pressSequentially(draft);
  await expect(editor).toHaveText(draft);
  await expect(undo(page)).toHaveAccessibleName('Undo Edit annotation');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await expect(editor).toBeFocused();

  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  expect(await exportedText(page)).toContain(draft);
  await historyStep(page, 'Undo', 'Edit annotation');
  expect(await exportedText(page)).not.toContain(draft);
  await expect(undo(page)).toHaveAccessibleName('Undo Add annotation');
  await historyStep(page, 'Undo', 'Add annotation');
  await expect(undo(page)).toBeDisabled();
  await historyStep(page, 'Redo', 'Add annotation');
  expect(await exportedText(page)).not.toContain(draft);
  await historyStep(page, 'Redo', 'Edit annotation');
  expect(await exportedText(page)).toContain(draft);
  await expect(redo(page)).toBeDisabled();

  await page.getByTitle('Select (V)', { exact: true }).click();
  const restoredBounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.dblclick(restoredBounds.x + 90, restoredBounds.y + 230);
  await expect(editor).toBeFocused();
  const immediate = 'Direct export draft';
  await editor.fill(immediate);
  // Click Export directly: no blur wait, autosave wait, Enter, or tool switch.
  const output = await exportedText(page);
  expect(output).toContain(immediate);
  expect(output).not.toContain(draft);
  await historyStep(page, 'Undo', 'Edit annotation');
  expect(await exportedText(page)).toContain(draft);
  await historyStep(page, 'Redo', 'Edit annotation');
  expect(await exportedText(page)).toContain(immediate);
});

test('Escape cancels original text drafts without losing redo; focused drafts survive refresh as one edit', async ({ page }) => {
  await openSource(page);
  let editor = await startOriginalTextEdit(page, original);
  const previous = 'Previous committed edit';
  await editor.fill(previous);
  await editor.press('Enter');
  await historyStep(page, 'Undo', 'Edit original text');
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toHaveAccessibleName('Redo Edit original text');

  editor = await startOriginalTextEdit(page, original);
  await editor.fill('');
  await editor.pressSequentially('Canceled draft');
  await expect(undo(page)).toBeEnabled();
  await expect(redo(page)).toBeDisabled();
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.text-block').filter({ hasText: original })).toHaveCount(1);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toHaveAccessibleName('Redo Edit original text');
  await expect(redo(page)).toBeEnabled();
  const canceledOutput = await exportedText(page);
  expect(canceledOutput).toContain(original);
  expect(canceledOutput).not.toContain('Canceled draft');
  await historyStep(page, 'Redo', 'Edit original text');
  expect(await exportedText(page)).toContain(previous);
  await historyStep(page, 'Undo', 'Edit original text');

  editor = await startOriginalTextEdit(page, original);
  await editor.fill('');
  await editor.pressSequentially('Saved live draft');
  // Include Unicode and a later update in the same focus group.
  const draft = 'Saved live draft 中文';
  await editor.fill(draft);
  await expect(redo(page)).toBeDisabled();
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await expect(editor).toBeFocused();
  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  const restored = await exportedText(page);
  expect(restored).toContain(draft);
  expect(restored).not.toContain(original);
  await historyStep(page, 'Undo', 'Edit original text');
  const undone = await exportedText(page);
  expect(undone).toContain(original);
  expect(undone).not.toContain(draft);
  await expect(undo(page)).toBeDisabled();
  await historyStep(page, 'Redo', 'Edit original text');
  expect(await exportedText(page)).toContain(draft);
  await expect(redo(page)).toBeDisabled();
});
