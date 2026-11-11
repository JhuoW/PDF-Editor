// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TextPropertiesPanel } from '../../src/components/TextBox/TextPropertiesPanel';
import { useAnnotationStore } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { DEFAULT_TEXT_STYLE, type FreeTextAnnotation } from '../../src/annotations/types';
import { parseTipTapHTML } from '../../src/utils/tiptapConverter';
import { useTextBoxStore } from '../../src/store/textBoxStore';

let host: HTMLDivElement, root: Root;
function annotation() { return useAnnotationStore.getState().getAllAnnotations()[0] as FreeTextAnnotation; }
function Panel() { const annotations = useAnnotationStore(state => state.annotations); return <TextPropertiesPanel annotation={annotations.get(1)![0] as FreeTextAnnotation} />; }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const source: FreeTextAnnotation = { id: 'text', type: 'freetext', pageNumber: 1, createdAt: new Date(), modifiedAt: new Date(),
    color: '#000000', opacity: 1, content: 'Mixed colors', rect: [20, 40, 220, 80], style: { ...DEFAULT_TEXT_STYLE },
    richContent: [ { text: 'Mixed ', style: { ...DEFAULT_TEXT_STYLE, color: '#cc0000' } }, { text: 'colors', style: { ...DEFAULT_TEXT_STYLE, color: '#0000cc', fontStyle: 'italic' } } ] };
  useAnnotationStore.setState({ annotations: new Map([[1, [source]]]) }); useTextBoxStore.setState({ tiptapEditor: null });
  vi.spyOn(useAnnotationHistoryStore.getState(), 'recordUpdate');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Panel />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('applies whole-box properties to existing text while retaining unrelated mixed formatting and reusable HTML', async () => {
  const bold = host.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!;
  await act(async () => bold.click());
  expect(bold.getAttribute('aria-pressed')).toBe('true');
  expect(annotation().richContent!.map(segment => segment.style.fontWeight)).toEqual(['bold', 'bold']);
  expect(annotation().richContent!.map(segment => segment.style.color)).toEqual(['#cc0000', '#0000cc']);
  expect(annotation().richContent![1].style.fontStyle).toBe('italic');
  const reopened = parseTipTapHTML(annotation().htmlContent!, annotation().style);
  expect(reopened.map(segment => segment.text).join('')).toBe('Mixed colors');
  expect(reopened.every(segment => segment.style.fontWeight === 'bold')).toBe(true);
  expect(useAnnotationHistoryStore.getState().recordUpdate).toHaveBeenCalledTimes(1);
});

it('does not change existing font size until a valid draft is committed', async () => {
  const size = host.querySelector<HTMLInputElement>('input[aria-label="Custom font size"]')!;
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(size, value); size.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await type('-12'); await act(async () => size.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(annotation().style.fontSize).toBe(14); expect(useAnnotationHistoryStore.getState().recordUpdate).not.toHaveBeenCalled();
  await type('23.5'); expect(annotation().style.fontSize).toBe(14);
  await act(async () => size.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(annotation().style.fontSize).toBe(23.5); expect(annotation().richContent!.every(segment => segment.style.fontSize === 23.5)).toBe(true);
  expect(parseTipTapHTML(annotation().htmlContent!, annotation().style).every(segment => segment.style.fontSize === 23.5)).toBe(true);
});
