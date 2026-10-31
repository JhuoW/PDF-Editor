import { describe, expect, it } from 'vitest';
import { layoutText, type TextLayoutInput } from '../../src/editing/TextLayout';

const input = (overrides: Partial<TextLayoutInput> = {}): TextLayoutInput => ({ text: 'First paragraph has several words that wrap naturally.\nSecond paragraph.', rect: { x: 20, y: 30, width: 125, height: 200 }, fontName: 'Helvetica', fontSize: 12, fontColor: '#123456', alignment: 'left', lineHeight: 1.3, ...overrides });
const compact = (text: string) => text.replace(/\s/g, '');

describe('shared measured paragraph layout', () => {
  it('keeps a complete word at the right edge when only its trailing space overflows', async () => {
    const result = await layoutText(input({ text: 'alpha beta gamma delta third line', fontName: 'Courier', fontSize: 12,
      rect: { x: 40, y: 88, width: 79.2, height: 44 }, legacyBaseline: 100, lineHeight: 16 / 12 }));
    expect(result.lines.map(line => line.text)).toEqual(['alpha beta', 'gamma delta', 'third line']);
    expect(result.fits).toBe(true);
    expect(result.requiredHeight).toBe(44);
  });
  it('keeps tight source leading so two 11pt rows fit their original 20pt region', async () => {
    const value = input({ text: 'omega beta\ngamma delta', fontName: 'Courier', fontSize: 11, lineHeight: 9 / 11, legacyBaseline: 80, rect: { x: 40, y: 69, width: 73, height: 20 } });
    expect((await layoutText({ ...value, lineHeight: 1 })).overflow).toContain('needs 22 points of height, but the region has 20');
    const result = await layoutText(value);
    expect(result.fits).toBe(true); expect(result.requiredHeight).toBe(20);
    expect(result.lines.map(line => line.baseline)).toEqual([80, 89]);
  });
  it('preserves compressed word spacing in an unchanged source row instead of wrapping it again', async () => {
    const text = 'Original justified source row';
    const natural = await layoutText(input({ text, rect: { x: 0, y: 0, width: 600, height: 100 } }));
    const width = natural.lines[0].width - 3;
    const value = input({ text, legacyBaseline: 12, rect: { x: 0, y: 0, width, height: 12 } });
    expect((await layoutText(value)).fits).toBe(false);
    const kept = await layoutText({ ...value, sourceRows: [{ text, width }] });
    expect(kept.fits).toBe(true); expect(kept.lines).toHaveLength(1); expect(kept.lines[0].text).toBe(text);
    expect(kept.lines[0].width).toBeCloseTo(width, 3);
  });
  it('wraps Latin words, retains paragraph endings and returns serializable positions without changing input', async () => {
    const value = input(), copy = structuredClone(value), layout = await layoutText(value);
    expect(layout.fits).toBe(true); expect(layout.lines.length).toBeGreaterThan(2); expect(layout.lines.filter(line => line.paragraphEnd)).toHaveLength(2);
    expect(compact(layout.lines.map(line => line.text).join(''))).toBe(compact(value.text));
    for (const line of layout.lines) { expect(line.width).toBeLessThanOrEqual(value.rect.width + 0.001); expect(line.baseline).toBeGreaterThan(value.rect.y); }
    expect(structuredClone(layout)).toEqual(layout); expect(value).toEqual(copy);
  });
  it('wraps mixed CJK punctuation without dropping characters or starting wrapped lines with closing punctuation', async () => {
    const value = input({ text: '中文排版（第一段），保留标点。第二句包含 English words 和中文测试。', rect: { x: 0, y: 0, width: 100, height: 300 } }), layout = await layoutText(value);
    expect(layout.fits).toBe(true); expect(compact(layout.lines.map(line => line.text).join(''))).toBe(compact(value.text));
    for (const line of layout.lines) { expect(line.text).not.toMatch(/^[，。、）]/); expect(line.text).not.toMatch(/[（]$/); }
    expect(layout.warnings.join(' ')).toContain('fallback');
  });
  it.each(['left', 'center', 'right'] as const)('keeps italic ink inside the region with %s alignment', async alignment => {
    const value = input({ text: 'Italic fjy', fontName: 'Times-Italic', fontSize: 32, alignment, rect: { x: 40, y: 60, width: 250, height: 80 } }), layout = await layoutText(value);
    expect(layout.fits).toBe(true); expect(layout.inkBounds!.x).toBeGreaterThanOrEqual(value.rect.x - 0.001); expect(layout.inkBounds!.y).toBeGreaterThanOrEqual(value.rect.y - 0.001);
    expect(layout.inkBounds!.x + layout.inkBounds!.width).toBeLessThanOrEqual(value.rect.x + value.rect.width + 0.001);
    expect(layout.inkBounds!.y + layout.inkBounds!.height).toBeLessThanOrEqual(value.rect.y + value.rect.height + 0.001);
  });
  it.each(['alpha beta gamma delta epsilon zeta eta theta', '中文文字自动两端对齐测试排版保留所有文字'])('justifies wrapped lines while keeping the final paragraph line unstretched (%s)', async text => {
    const value = input({ text, alignment: 'justify', rect: { x: 0, y: 0, width: 110, height: 300 } }), result = await layoutText(value);
    expect(result.lines.length).toBeGreaterThan(1);
    for (const line of result.lines.slice(0, -1)) expect(line.width).toBeCloseTo(110, 5);
    expect(result.lines.at(-1)!.width).toBeLessThan(110); expect(result.lines.at(-1)!.paragraphEnd).toBe(true);
    expect(compact(result.lines.map(line => line.text).join(''))).toBe(compact(text));
  });
  it('offers verified font and height suggestions without silently applying them', async () => {
    const value = input({ fontSize: 24, rect: { x: 0, y: 0, width: 160, height: 45 } }), result = await layoutText(value);
    expect(result.fits).toBe(false); expect(result.fontSize).toBe(24); expect(result.overflow).toContain('no text was truncated'); expect(result.suggestedFontSize).toBeLessThan(24);
    expect((await layoutText({ ...value, fontSize: result.suggestedFontSize! })).fits).toBe(true);
    expect((await layoutText({ ...value, rect: { ...value.rect, height: result.requiredHeight } })).fits).toBe(true);
  });
  it('retains the baseline and nominal fit of legacy single-line CJK replacements', async () => {
    const result = await layoutText(input({ text: '中文替换', fontSize: 12, rect: { x: 20, y: 68, width: 150, height: 12 }, legacyBaseline: 80 }));
    expect(result.fits).toBe(true); expect(result.requiredHeight).toBe(12); expect(result.lines[0].baseline).toBe(80);
  });
  it('computes legacy fit suggestions for the explicit layout that the action will actually create', async () => {
    const value = input({ text: 'Longer text needs a smaller font', fontName: 'Helvetica-Bold', fontSize: 12, lineHeight: 1.2,
      rect: { x: 30, y: 68, width: 70.02, height: 12 }, legacyBaseline: 80 });
    const result = await layoutText(value); expect(result.fits).toBe(false); expect(result.lines[0].baseline).toBe(80);
    expect(result.suggestedFontSize).toBeDefined(); expect(result.suggestedHeight).toBeDefined();
    const explicit = { ...value, legacyBaseline: undefined };
    const smaller = await layoutText({ ...explicit, fontSize: result.suggestedFontSize! }); expect(smaller.fits).toBe(true);
    const taller = await layoutText({ ...explicit, rect: { ...explicit.rect, height: result.suggestedHeight! } }); expect(taller.fits).toBe(true);
    expect(compact(smaller.lines.map(line => line.text).join(''))).toBe(compact(value.text));
    expect(compact(taller.lines.map(line => line.text).join(''))).toBe(compact(value.text));
  });
  it('supports deletion and blank paragraphs while clearly rejecting unsupported scripts and glyphs', async () => {
    const deleted = await layoutText(input({ text: '' })); expect(deleted.fits).toBe(true); expect(deleted.lines).toEqual([]); expect(deleted.requiredHeight).toBe(0);
    const blank = await layoutText(input({ text: 'First\n\nLast' })); expect(blank.lines).toHaveLength(3); expect(blank.lines[1].glyphs).toEqual([]);
    await expect(layoutText(input({ text: 'العربية' }))).rejects.toThrow(/complex-script/); await expect(layoutText(input({ text: '\u{10ffff}' }))).rejects.toThrow(/does not support/);
  });
  it('rejects invalid geometry, style values and cancellation before producing a result', async () => {
    await expect(layoutText(input({ fontName: 'Custom missing font' }))).rejects.toThrow(/standard text fonts/);
    await expect(layoutText(input({ fontSize: 0 }))).rejects.toThrow(/Font size/); await expect(layoutText(input({ lineHeight: 0.2 }))).rejects.toThrow(/Line spacing/);
    await expect(layoutText(input({ fontColor: 'red' }))).rejects.toThrow(/six-digit/);
    const controller = new AbortController(); controller.abort(); await expect(layoutText(input(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
