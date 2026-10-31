import { expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { inspectWorkspaceText, exportWorkspacePDF } from '../../src/core/PDFExport';
import { prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { TextCheckError } from '../../src/editing/TextCheckTypes';
import type { TextBlock } from '../../src/editing/types';

async function fixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman), workspace = createWorkspace();
  for (const pageNumber of [1, 2]) {
    pdf.addPage([300, 400]).drawText('Original text', { x: 30, y: 350, size: 12, font });
    const block: TextBlock = { id: `text-${pageNumber}`, pageNumber, text: 'Original text', editable: true,
      rect: { x: 30, y: 38, width: 80, height: 18 },
      lines: [{ text: 'Original text', x: 30, y: 38, baseline: 50, height: 12, width: font.widthOfTextAtSize('Original text', 12), items: [] }],
      style: { fontName: 'serif', fontSize: 12, lineHeight: 1.2, alignment: 'left' } };
    workspace.editing.textBlocks.set(pageNumber, [block]);
  }
  return { data: new Uint8Array(await pdf.save()).buffer, workspace };
}

it('reports every overflowing region before export writes any replacement content', async () => {
  const { data, workspace } = await fixture(), original = data.slice(0);
  workspace.editing.textEdits = [...workspace.editing.textBlocks.values()].flat().map(block => ({ blockId: block.id, originalText: block.text, newText: 'Much longer text. '.repeat(20), timestamp: 1 }));
  const report = await inspectWorkspaceText(data, workspace);
  expect(report.checked).toBe(2); expect(report.issues.filter(issue => issue.blocking).map(issue => issue.pageNumber)).toEqual([1, 2]);
  await expect(exportWorkspacePDF(data, workspace)).rejects.toBeInstanceOf(TextCheckError);
  await expect(exportWorkspacePDF(data, workspace)).rejects.toMatchObject({ issues: expect.arrayContaining([
    expect.objectContaining({ pageNumber: 1, blockId: 'text-1' }), expect.objectContaining({ pageNumber: 2, blockId: 'text-2' }),
  ]) });
  expect(data).toEqual(original);
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  try { expect(text.asText()).toContain('Original text'); } finally { text.destroy(); page.destroy(); pdf.destroy(); }
});

it('identifies actual original fonts, user-selected fonts, and added CJK fallback', async () => {
  const { data, workspace } = await fixture(), block = workspace.editing.textBlocks.get(1)![0];
  const original = await prepareTextEditLayout(data, block);
  expect(original.fonts?.original.join(',')).toMatch(/Times|NimbusRoman/i); expect(original.fonts?.mode).toBe('original');
  const selected = await prepareTextEditLayout(data, block, { blockId: block.id, originalText: block.text, newText: 'Updated', timestamp: 1, layout: { fontName: 'Courier' } });
  expect(selected.fonts?.mode).toBe('selected'); expect(selected.fonts?.used.join(',')).toMatch(/Courier|NimbusMono/i);
  const mixed = await prepareTextEditLayout(data, block, { blockId: block.id, originalText: block.text, newText: '中文', timestamp: 1 });
  expect(mixed.fonts?.mode).toBe('fallback'); expect(mixed.fonts?.used.length).toBeGreaterThan(0);
});

it('keeps unsupported-edit errors attached to their block so text checks can locate them', async () => {
  const { data, workspace } = await fixture();
  workspace.editing.textEdits = [...workspace.editing.textBlocks.values()].flat().map(block => ({ blockId: block.id, originalText: block.text, newText: 'مرحبا', timestamp: 1 }));
  const report = await inspectWorkspaceText(data, workspace);
  expect(report.checked).toBe(2);
  expect(report.issues.filter(issue => issue.blocking).map(issue => issue.blockId)).toEqual(['text-1', 'text-2']);
  await expect(exportWorkspacePDF(data, workspace)).rejects.toMatchObject({ issues: expect.arrayContaining([
    expect.objectContaining({ blockId: 'text-1', kind: 'unsupported' }), expect.objectContaining({ blockId: 'text-2', kind: 'unsupported' }),
  ]) });
});

it('lists untouched read-only regions for review without blocking export', async () => {
  const { data, workspace } = await fixture();
  workspace.editing.textBlocks.get(2)![0].editable = false;
  workspace.editing.textBlocks.get(2)![0].unsupportedReason = 'Rotated text cannot be edited.';
  const report = await inspectWorkspaceText(data, workspace);
  expect(report.issues).toContainEqual(expect.objectContaining({ blockId: 'text-2', pageNumber: 2, kind: 'unsupported', blocking: false }));
  expect(await exportWorkspacePDF(data, workspace)).toEqual(new Uint8Array(data));
});

it('honors cancellation before inspection and export without mutating the workspace', async () => {
  const { data, workspace } = await fixture(), control = { signal: AbortSignal.abort() };
  await expect(inspectWorkspaceText(data, workspace, control)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(exportWorkspacePDF(data, workspace, control)).rejects.toMatchObject({ name: 'AbortError' });
  expect(workspace.editing.textEdits).toEqual([]);
});
