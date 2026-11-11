// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STYLE } from '../../src/annotations/types';
import { parseTipTapHTML, segmentsToTipTapHTML } from '../../src/utils/tiptapConverter';

describe('text-box rich formatting persists through HTML and typed runs', () => {
  it('keeps fractional font sizes and inline highlight colors when reopened', () => {
    const source = '<p><span style="font-size:23.5px;color:#123456"><strong><mark data-color="#ffff00">标注 中文</mark></strong></span></p><p>Next line</p>';
    const runs = parseTipTapHTML(source, DEFAULT_TEXT_STYLE);
    expect(runs.map(run => run.text).join('')).toBe('标注 中文\nNext line');
    expect(runs[0].style).toMatchObject({ fontSize: 23.5, fontWeight: 'bold', color: '#123456', highlightColor: '#ffff00' });
    const restored = parseTipTapHTML(segmentsToTipTapHTML(runs, DEFAULT_TEXT_STYLE), DEFAULT_TEXT_STYLE);
    expect(restored).toEqual(runs);
  });
  it('does not merge adjacent runs with different highlights or spacing', () => {
    const runs = parseTipTapHTML('<p><mark data-color="#ffff00">A</mark><mark data-color="#00ff00">B</mark>C</p>', DEFAULT_TEXT_STYLE);
    expect(runs).toHaveLength(3);
    expect(runs.map(run => run.style.highlightColor)).toEqual(['#ffff00', '#00ff00', undefined]);
  });
});
