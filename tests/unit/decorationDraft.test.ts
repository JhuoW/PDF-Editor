import { describe, expect, it } from 'vitest';
import { buildDecorationOperations, createDecorationDraft, formatDecorationPages, parseDecorationPages } from '../../src/components/Dialogs/decorationDraft';
import type { ManagedPageDecoration } from '../../src/core/PageDecorationTypes';

describe('page decoration drafts', () => {
  it('resolves page ranges and parity without duplicate Bates numbers', () => {
    expect(parseDecorationPages('1, 3-6, 4', 8, 'all')).toEqual([1, 3, 4, 5, 6]);
    expect(parseDecorationPages('1-8', 8, 'odd')).toEqual([1, 3, 5, 7]);
    expect(parseDecorationPages('1-8', 8, 'even')).toEqual([2, 4, 6, 8]);
    for (const value of ['', '0', '2-1', '1-9', 'x', '1,']) expect(() => parseDecorationPages(value, 8, 'all')).toThrow();
    expect(() => parseDecorationPages('1', 8, 'even')).toThrow('select no pages');
    expect(formatDecorationPages([1, 2, 3, 5, 8, 9])).toBe('1-3, 5, 8-9');
  });
  it('creates independent defaults for all three kinds', () => {
    const watermark = createDecorationDraft('watermark', [1]), headers = createDecorationDraft('header-footer', [1]), background = createDecorationDraft('background', [1]);
    expect(watermark.definition).toMatchObject({ kind: 'watermark', content: { type: 'text', text: 'DRAFT' }, opacity: .25 });
    expect(headers.definition).toMatchObject({ kind: 'header-footer', slots: { footerCenter: '{page} / {pages}' }, bates: { digits: 6 } });
    expect(background.definition).toMatchObject({ kind: 'background', fill: { type: 'color' } });
    expect(new Set([watermark.id, headers.id, background.id]).size).toBe(3);
  });
  it('targets owned IDs only and leaves unchanged or unowned decoration data intact', () => {
    const first = createDecorationDraft('watermark', [1]);
    const original: ManagedPageDecoration[] = [{ id: 'owned', definition: first.definition, pages: [1], managed: true, needsRefresh: false }, { id: 'unsafe', definition: first.definition, pages: [1], managed: false, needsRefresh: false }];
    expect(buildDecorationOperations(original, [{ ...first, id: 'owned', changed: false }])).toEqual([]);
    expect(buildDecorationOperations(original, [])).toEqual([{ type: 'remove', id: 'owned' }]);
    expect(buildDecorationOperations(original, [{ ...first, id: 'owned' }])).toEqual([{ type: 'update', id: 'owned', definition: first.definition }]);
    expect(buildDecorationOperations([], [first])).toEqual([{ type: 'create', definition: first.definition }]);
  });
});
