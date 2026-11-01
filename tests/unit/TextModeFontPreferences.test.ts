import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectFont } from '../../src/fonts/fontAsset';
import { bakeWorkspaceContent, exportWorkspacePDF, flattenWorkspaceForm } from '../../src/core/PDFExport';
import { performPageManagement } from '../../src/core/PageManagementWorkspace';
import { preparePDFLinksWorkspace, applyPDFLinksWorkspace } from '../../src/core/PDFLinksWorkspace';
import { preparePDFBookmarksWorkspace, applyPDFBookmarksWorkspace } from '../../src/core/PDFBookmarksWorkspace';
import { cleanWorkspacePDF } from '../../src/core/DocumentCleanupWorkspace';
import { prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { createWorkspace, captureWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import { useEditingStore } from '../../src/store/editingStore';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

afterEach(() => useEditingStore.getState().clearAll());
it.each(['mode', 'crop', 'flatten', 'links', 'bookmarks', 'cleanup'])('retains an imported full font through %s and recovery, even when old wording cannot use it', async operation => {
  const bytes = await readFile(new URL('../fixtures/fonts/TestCJK.otf', import.meta.url));
  const asset = await inspectFont(new Uint8Array(bytes).buffer, 'TestCJK.otf');
  const document = await PDFDocument.create();
  document.addPage([400, 600]).drawText('Original editable text', { x: 40, y: 500, size: 12 });
  const data = new Uint8Array(await document.save()).buffer;
  const block: TextBlock = { id: 'font-source', kind: 'line', pageNumber: 1, text: 'Original editable text', editable: true,
    rect: { x: 40, y: 88, width: 180, height: 12 },
    lines: [{ text: 'Original editable text', items: [], x: 40, y: 88, width: 180, height: 12, baseline: 100 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
  const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: block.text, font: asset, timestamp: 1,
    layout: { fontName: asset.id, keepBaseline: true, fitToContent: true, flow: 'object' } };
  const prepared = await prepareTextEditLayout(data, block, edit);
  const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [block]); workspace.editing.textEdits = [edit];
  const baked = operation === 'crop' ? await performPageManagement(data, workspace, { action: 'crop', pages: [1], margins: { top: 0, bottom: 10, left: 0, right: 0 } })
    : operation === 'flatten' ? await flattenWorkspaceForm(data, workspace)
      : operation === 'links' ? await applyPDFLinksWorkspace((await preparePDFLinksWorkspace(data, workspace)).data, workspace, [])
        : operation === 'bookmarks' ? await applyPDFBookmarksWorkspace((await preparePDFBookmarksWorkspace(data, workspace)).data, workspace, [])
          : operation === 'cleanup' ? await cleanWorkspacePDF(data, workspace, { metadata: true, attachments: false, activeContent: false, comments: false, links: false, forms: false, privateData: false })
            : await bakeWorkspaceContent(data, workspace);
  expect(baked.workspace.editing.textFontPreferences?.get(block.id)?.font?.id).toBe(asset.id);
  restoreWorkspace(baked.workspace);
  const row = prepared.layout.lines[0];
  const detected: TextBlock = { ...block, id: 'new-detection', region: block.id, kind: 'paragraph',
    rect: { x: row.x, y: row.baseline - 12, width: row.width, height: 12 },
    lines: [{ ...block.lines[0], x: row.x, width: row.width, baseline: row.baseline }] };
  useEditingStore.getState().setTextBlocks(1, [detected]);
  const selected = useEditingStore.getState().getBlock(detected.id)!;
  expect(selected.fontPreference?.fontName).toBe(asset.id);
  restoreWorkspace(captureWorkspace());
  useEditingStore.getState().updateBlockText(detected.id, '中文字体编辑 ABC', undefined, { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' });
  const output = await exportWorkspacePDF(new Uint8Array(baked.data).buffer, captureWorkspace());
  const pdf = new mupdf.PDFDocument(output), page = pdf.loadPage(0), text = page.toStructuredText('');
  const fonts: string[] = [];
  try {
    text.walk({ onChar(character, _origin, font) { try { if (character === '中') fonts.push(font.getName()); } finally { font.destroy(); } } });
    expect(text.asText()).toContain('中文字体编辑 ABC');
    expect(fonts).toEqual([asset.name]);
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
});
