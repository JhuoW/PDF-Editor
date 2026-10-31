import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PDFDocument } from 'pdf-lib';
import { cffGlyphCIDs } from '../../src/fonts/cffCharset';
import { inspectFont, validateFontData } from '../../src/fonts/fontAsset';
import { fontLibrary } from '../../src/fonts/fontLibrary';
import { TextLayoutSession } from '../../src/editing/TextLayout';
import { applyTextEdits, prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { loadMuPDF } from '../../src/utils/mupdf';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { textObjectEdit } from '../../src/editing/objectOperations';
import { captureWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import { workspaceSaveHash } from '../../src/store/documentSaveStore';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

async function font(extension = 'otf') {
  const bytes = await readFile(new URL(`../fixtures/fonts/TestCJK.${extension}`, import.meta.url));
  return inspectFont(new Uint8Array(bytes).buffer, `TestCJK.${extension}`);
}
const block: TextBlock = { id: 'block-1-0', pageNumber: 1, editable: true, text: 'OLD CONTENT', rect: { x: 30, y: 60, width: 300, height: 80 },
  lines: [{ items: [], text: 'OLD CONTENT', x: 30, y: 68, width: 100, height: 12, baseline: 80 }],
  style: { fontName: 'Helvetica', fontSize: 12, lineHeight: 1.2, alignment: 'left' } };
afterEach(() => { useEditingStore.getState().clearAll(); useHistoryStore.getState().clearHistory(); });

describe('portable Chinese font programs', () => {
  it.each(['ttf', 'otf'])('validates and uses actual %s glyph metrics in preview and export, retaining Unicode', async extension => {
    const asset = await font(extension), engine = await loadMuPDF();
    expect(asset.chinese).toBe(true); expect(asset.id).toMatch(/^custom:[a-f0-9]{64}$/);
    expect((await inspectFont(asset.data, 'renamed.otf')).id).toBe(asset.id);
    const source = await PDFDocument.create(), page = source.addPage([400, 600]);
    page.drawText(block.text, { x: 30, y: 520, size: 12 }); page.drawText('UNCHANGED', { x: 30, y: 200, size: 12 });
    const data = new Uint8Array(await source.save()).buffer;
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: '中文字体编辑 ABC\n搜索测试，第二行。', timestamp: 1,
      font: asset, layout: { fontName: asset.id, fontSize: 18, targetRect: block.rect } };
    const preview = await prepareTextEditLayout(data, block, edit);
    expect(preview.layout.fits).toBe(true); expect(preview.fonts.mode).toBe('selected'); expect(preview.fonts.used).toEqual([asset.name]);
    expect(preview.layout.warnings).toEqual([]);
    const bytes = await applyTextEdits(data, new Map([[1, [block]]]), [edit]);
    const pdf = new engine.PDFDocument(bytes), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
    // Compare the exported raster against drawing the imported font program directly.
    // Text extraction alone cannot detect a CFF CID charset that paints missing/wrong glyphs.
    const expected = new engine.Pixmap(engine.ColorSpace.DeviceRGB, [0, 0, 400, 600], false); expected.clear(255);
    const device = new engine.DrawDevice(engine.Matrix.identity, expected), session = new TextLayoutSession(engine);
    session.useImportedFont(asset); session.draw(device, preview.input, preview.layout); device.close(); device.destroy(); session.destroy();
    const actual = sheet.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, true);
    try {
      let difference = 0, ink = 0;
      const wanted = expected.getPixels(), painted = actual.getPixels();
      for (let y = 60; y < 140; y++) for (let x = 30; x < 330; x++) for (let c = 0; c < 3; c++) {
        const index = (y * 400 + x) * 3 + c;
        difference += Math.abs(wanted[index] - painted[index]); ink += 255 - wanted[index];
      }
      expect(ink).toBeGreaterThan(10000); expect(difference / ink).toBeLessThan(.02);
    } finally { expected.destroy(); actual.destroy(); }
    const used: string[] = [], sizes: number[] = [];
    try {
      const actual = text.asText(); expect(actual).toContain('中文字体编辑 ABC'); expect(actual).toContain('搜索测试，第二行。'); expect(actual).toContain('UNCHANGED'); expect(actual).not.toContain(block.text);
      text.walk({ onChar(character, _origin, face, size) { try { if ('中文字'.includes(character)) { used.push(face.getName()); sizes.push(size); } } finally { face.destroy(); } } });
      expect(new Set(used)).toEqual(new Set([asset.name])); expect(sizes.every(size => size === 18)).toBe(true);
    } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
  });
  it('distinguishes explicit built-in selection from fallback and refuses missing custom data', async () => {
    const session = new TextLayoutSession(await loadMuPDF());
    const input = { text: '中文 ABC', rect: { x: 0, y: 0, width: 250, height: 80 }, fontName: 'zh-Hans', fontSize: 18, fontColor: '#000000', alignment: 'left' as const, lineHeight: 1.2 };
    try {
      expect(session.layout(input).warnings).toEqual([]);
      expect(session.layout({ ...input, fontName: 'Helvetica' }).warnings.join(' ')).toContain('fallback');
      expect(() => session.layout({ ...input, fontName: `custom:${'0'.repeat(64)}` })).toThrow('font data is missing');
      const asset = await font(); session.useImportedFont(asset);
      expect(session.layout({ ...input, fontName: asset.id, text: '中文龙' }).warnings.join(' ')).toContain('fallback');
    } finally { session.destroy(); }
  });
  it('rejects unsupported collections, corrupt offsets and oversized programs before parsing', async () => {
    expect(() => validateFontData(new ArrayBuffer(8))).toThrow('valid TTF or OTF');
    const asset = await font(); expect(cffGlyphCIDs(asset.data)?.some((cid, gid) => cid !== gid)).toBe(true);
    const collection = asset.data.slice(0); new DataView(collection).setUint32(0, 0x74746366);
    expect(() => validateFontData(collection)).toThrow('valid TTF or OTF');
    const corrupt = asset.data.slice(0); new DataView(corrupt).setUint32(20, 0xffffffff);
    expect(() => validateFontData(corrupt)).toThrow('damaged tables');
    expect(() => validateFontData(new ArrayBuffer(32 * 1024 * 1024 + 1))).toThrow('32 MB');
  });
  it('keeps font bytes through typing, object moves, restored snapshots and original-font reset', async () => {
    const asset = await font(); useEditingStore.getState().setTextBlocks(1, [structuredClone(block)]);
    useEditingStore.getState().updateBlockLayout({ blockId: block.id, originalText: block.text, newText: block.text, font: asset, layout: { fontName: asset.id }, timestamp: 0 });
    useEditingStore.getState().updateBlockText(block.id, '中文编辑');
    const current = useEditingStore.getState().getBlock(block.id)!;
    useEditingStore.getState().applyObjectEdits({ textEdits: [textObjectEdit(current, { ...block.rect, x: 40 })] }, 'Move');
    const snapshot = captureWorkspace(), hash = workspaceSaveHash(snapshot);
    useEditingStore.getState().clearAll(); restoreWorkspace(snapshot);
    expect(useEditingStore.getState().textEdits[0].font).toEqual(asset); expect(workspaceSaveHash(captureWorkspace())).toBe(hash);
    const edit = useEditingStore.getState().textEdits[0]; useEditingStore.getState().updateBlockLayout({ ...edit, layout: { ...edit.layout, fontName: undefined } });
    expect(useEditingStore.getState().textEdits[0].font).toBeUndefined(); expect(workspaceSaveHash(captureWorkspace())).not.toBe(hash);
  });
  it('repairs a missing font program even when text and the selected font key are unchanged', async () => {
    const asset = await font(); useEditingStore.getState().setTextBlocks(1, [structuredClone(block)]);
    const edit = { blockId: block.id, originalText: block.text, newText: block.text, layout: { fontName: asset.id }, timestamp: 1 };
    useEditingStore.setState({ textEdits: [edit] });
    useEditingStore.getState().updateBlockLayout({ ...edit, font: asset });
    expect(useEditingStore.getState().textEdits[0].font).toEqual(asset);
  });
  it('persists a deduplicated library independently from editable document assets', async () => {
    globalThis.indexedDB = new IDBFactory(); const asset = await font();
    expect(await fontLibrary()).toEqual([]); await fontLibrary({ add: asset }); await fontLibrary({ add: { ...asset, fileName: 'copy.otf' } });
    const loaded = await fontLibrary(); expect(loaded).toHaveLength(1); expect(loaded[0].data).toEqual(asset.data);
    await fontLibrary({ remove: asset.id }); expect(await fontLibrary()).toEqual([]); expect(loaded[0].data.byteLength).toBeGreaterThan(100);
  });
});
