import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyTextEdits, prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import type { TextBlock } from '../../src/editing/types';

const text = 'Move this paragraph';
const transform = (point: number[], matrix: number[]) => [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
async function fixture(rotated: boolean) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 600]), font = await pdf.embedFont(StandardFonts.Helvetica);
  if (rotated) { page.setCropBox(20, 30, 350, 550); page.setRotation(degrees(90)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  page.drawText(text, { x: 30, y: 520, size: 12, font });
  page.drawText('Neighbor stays', { x: 30, y: 200, size: 12, font });
  const unit = rotated ? 2 : 1, x = rotated ? 20 : 30, baseline = rotated ? 120 : 80, width = font.widthOfTextAtSize(text, 12) * unit;
  const block: TextBlock = { id: 'move-text', pageNumber: 1, text, editable: true,
    rect: { x, y: baseline - 12 * unit, width, height: 12 * unit },
    style: { fontName: 'Helvetica', fontSize: 12 * unit, alignment: 'left', lineHeight: 1.2 },
    lines: [{ text, items: [], x, y: baseline - 12 * unit, width, height: 12 * unit, baseline }] };
  return { data: new Uint8Array(await pdf.save()).buffer, block, unit };
}
function inspect(data: ArrayBuffer | Uint8Array) {
  const doc = new mupdf.PDFDocument(data), page = doc.loadPage(0), structured = page.toStructuredText('');
  let origin: number[] | undefined;
  try {
    structured.walk({ onChar(character, point, font) { try { if (!origin && character === 'M') origin = [...point]; } finally { font.destroy(); } } });
    return { origin: origin!, text: structured.asText(), matrix: page.getTransform() };
  } finally { structured.destroy(); page.destroy(); doc.destroy(); }
}

describe('moving original PDF text', () => {
  beforeEach(() => { useEditingStore.getState().clearAll(); useHistoryStore.getState().clearHistory(); });
  for (const rotated of [false, true]) it(`retains its baseline and source font on ${rotated ? 'a rotated cropped UserUnit page' : 'a normal page'}`, async () => {
    const { data, block, unit } = await fixture(rotated), before = inspect(data);
    const targetRect = { ...block.rect, x: block.rect.x + 45, y: block.rect.y + 35 };
    const edit = { blockId: block.id, originalText: text, newText: text, timestamp: 1, layout: { keepBaseline: true, translate: true, targetRect } };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.input.legacyBaseline).toBe(block.lines[0].baseline + 35);
    expect(prepared.input.sourceFontKey).toBeDefined(); expect(prepared.layout.fits).toBe(true);
    const after = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit]));
    const native = transform(before.origin, mupdf.Matrix.invert(before.matrix));
    const expected = transform([native[0] + 45 / unit, native[1] - 35 / unit], before.matrix);
    expect(after.origin[0]).toBeCloseTo(expected[0], 3); expect(after.origin[1]).toBeCloseTo(expected[1], 3);
    expect(after.text.match(/Move this paragraph/g)).toHaveLength(1); expect(after.text).toContain('Neighbor stays');
  });
  it('retains the moved layout when an inline content edit is reverted to its original text', async () => {
    const { block } = await fixture(false), state = useEditingStore.getState(); state.setTextBlocks(1, [block]);
    const layout = { keepBaseline: true, translate: true, targetRect: { ...block.rect, x: 70, y: 120 } };
    state.updateBlockLayout({ blockId: block.id, originalText: text, newText: text, timestamp: 1, layout });
    state.updateBlockText(block.id, 'Modified text'); state.updateBlockText(block.id, text);
    expect(useEditingStore.getState().textEdits).toHaveLength(1);
    expect(useEditingStore.getState().textEdits[0].layout).toEqual(layout);
    state.requestTextEdit(block.id); expect(useEditingStore.getState().pendingTextEditId).toBe(block.id);
    state.setMode('object'); expect(useEditingStore.getState().pendingTextEditId).toBeNull();
  });
  it('measures room for continued typing at the moved destination while keeping its baseline', async () => {
    const { data, block } = await fixture(false), targetRect = { ...block.rect, x: 85, y: 133 };
    const moved = { blockId: block.id, originalText: text, newText: text, timestamp: 1, layout: { keepBaseline: true, translate: true, targetRect } };
    const prepared = await prepareTextEditLayout(data, block, moved);
    expect(prepared.input.rect).toEqual(targetRect);
    expect(prepared.availableRect!.x).toBe(targetRect.x); expect(prepared.availableRect!.y).toBe(targetRect.y);
    expect(prepared.availableRect!.height).toBeGreaterThan(targetRect.height * 2);
    // Export must also work before an asynchronous UI preview has expanded the rectangle.
    const edit = { ...moved, newText: 'Moved paragraph remains editable and can grow naturally on the page.', layout: { ...moved.layout, reflow: true, autoGrow: true } };
    const expanded = await prepareTextEditLayout(data, block, edit);
    expect(expanded.layout.fits).toBe(true); expect(expanded.input.legacyBaseline).toBe(prepared.input.legacyBaseline);
    const result = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit]));
    expect(result.text.replace(/\s+/g, ' ')).toContain(edit.newText); expect(result.text).toContain('Neighbor stays');
  });
});
