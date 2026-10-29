import type { ManagedPageDecoration, PageDecorationDefinition, PageDecorationOperation } from '../../core/PageDecorationTypes';

export interface DecorationDraft { id: string; definition: PageDecorationDefinition; changed: boolean; managed: boolean; reason?: string; needsRefresh?: boolean }
export const decorationKindLabels = { watermark: 'Watermark', 'header-footer': 'Headers & footers', background: 'Background' };

export function createDecorationDraft(kind: PageDecorationDefinition['kind'], pages: number[]): DecorationDraft {
  const base = { name: decorationKindLabels[kind], pages, opacity: 1 };
  const definition: PageDecorationDefinition = kind === 'watermark'
    ? { ...base, kind, opacity: .25, content: { type: 'text', text: 'DRAFT', fontFamily: 'Helvetica', fontSize: 48, color: '#666666' }, angle: -30, position: { anchor: 'center', offsetX: 0, offsetY: 0 }, layer: 'foreground' }
    : kind === 'header-footer'
      ? { ...base, kind, slots: { footerCenter: '{page} / {pages}' }, fontFamily: 'Helvetica', fontSize: 10, color: '#333333', marginX: 36, marginTop: 24, marginBottom: 24, pageNumberStart: 1, bates: { start: 1, digits: 6, prefix: '', suffix: '' }, layer: 'foreground' }
      : { ...base, kind, fill: { type: 'color', color: '#f0f4ff' } };
  return { id: `draft-${crypto.randomUUID()}`, definition, changed: true, managed: true };
}

export function buildDecorationOperations(original: ManagedPageDecoration[], drafts: DecorationDraft[]): PageDecorationOperation[] {
  const existing = new Set(original.map(item => item.id));
  return [
    ...original.filter(item => item.managed && !drafts.some(draft => draft.id === item.id)).map(item => ({ type: 'remove' as const, id: item.id })),
    ...drafts.filter(item => item.managed && item.changed).map(item => existing.has(item.id)
      ? { type: 'update' as const, id: item.id, definition: item.definition }
      : { type: 'create' as const, definition: item.definition }),
  ];
}

export function parseDecorationPages(value: string, total: number, parity: 'all' | 'odd' | 'even'): number[] {
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const first = Number(match?.[1]), last = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > total) throw new Error(`Enter pages from 1 to ${total}, such as 1, 3-5.`);
    for (let page = first; page <= last; page++) if (parity === 'all' || (page % 2 === 1) === (parity === 'odd')) pages.add(page);
  }
  if (!pages.size) throw new Error('The page range and odd/even filter select no pages.');
  return [...pages].sort((a, b) => a - b);
}

export function formatDecorationPages(pages: number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < pages.length; index++) {
    const start = pages[index]; let end = start;
    while (index + 1 < pages.length && pages[index + 1] === end + 1) end = pages[++index];
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(', ');
}
