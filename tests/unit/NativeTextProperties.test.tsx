// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { NativeTextProperties } from '../../src/components/Workspace/NativeTextProperties';
import { prepareTextEditLayoutInWorker } from '../../src/editing/TextLayoutClient';
import type { PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock } from '../../src/editing/types';
import { useDocumentStore } from '../../src/store/documentStore';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { useLocaleStore } from '../../src/i18n';
import { registerPendingEditor } from '../../src/store/workspaceHistory';

vi.mock('../../src/editing/TextLayoutClient', () => ({ prepareTextEditLayoutInWorker: vi.fn() }));
const block: TextBlock = { id: 'source', pageNumber: 1, text: 'Original words', editable: true, lines: [],
  rect: { x: 20, y: 40, width: 100, height: 20 }, style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
let host: HTMLDivElement, root: Root, disposeEditor: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useLocaleStore.getState().setLocale('en');
  useEditingStore.getState().clearAll(); useHistoryStore.getState().clearHistory();
  useDocumentStore.setState({ document: { getData: async () => new Uint8Array([1, 2]) } as unknown as PDFDocumentProxy });
  useEditingStore.getState().setTextBlocks(1, [block]);
  vi.mocked(prepareTextEditLayoutInWorker).mockImplementation(async (_data, _block, edit) => ({
    input: { fontName: edit?.layout?.fontName ?? 'Helvetica', fontSize: edit?.layout?.fontSize ?? 12, fontColor: edit?.layout?.fontColor ?? '#123456', lineHeight: 1.2, alignment: 'left' },
  } as PreparedTextEditLayout));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { disposeEditor?.(); disposeEditor = undefined; await act(async () => { root.unmount(); }); host.remove(); useDocumentStore.setState({ document: null }); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function formatted() {
  useEditingStore.getState().updateBlockLayout({ blockId: block.id, originalText: block.text, newText: block.text, timestamp: 1,
    layout: { keepBaseline: true, fitToContent: true, fontName: 'Courier-Bold', fontSize: 20, fontColor: '#ff0000' } });
}
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
function SelectionPanel() {
  const selected = useEditingStore(state => state.selectedBlockId);
  return selected === block.id ? <NativeTextProperties block={block} onTextLayout={vi.fn()} /> : null;
}

describe('native source text formatting controls', () => {
  it('returns to the source font after reopening a formatted selection and choosing Original PDF font', async () => {
    formatted();
    await act(async () => { root.render(<NativeTextProperties block={block} onTextLayout={vi.fn()} />); });
    expect(button('Bold').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Text font"]')!;
      select.value = 'original'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button('Bold').getAttribute('aria-pressed')).toBe('false');
    await act(async () => { button('Bold').click(); });
    expect(useEditingStore.getState().textEdits[0].layout?.fontName).toBe('Helvetica-Bold');
  });

  it('shows source size, color and weight when an existing format change is undone after the panel opens', async () => {
    formatted();
    await act(async () => { root.render(<NativeTextProperties block={block} onTextLayout={vi.fn()} />); });
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('20');
    await act(async () => { useEditingStore.setState({ textEdits: [] }); });
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('12');
    expect(host.querySelector<HTMLInputElement>('input[type="color"]')!.value).toBe('#123456');
    expect(button('Bold').getAttribute('aria-pressed')).toBe('false');
  });
  it('keeps its selection and color control mounted while committing an active inline editor', async () => {
    useEditingStore.getState().selectBlock(block.id);
    disposeEditor = registerPendingEditor(() => useEditingStore.getState().selectBlock(null));
    await act(async () => { root.render(<SelectionPanel />); });
    const color = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    await act(async () => { color.focus(); });
    expect(useEditingStore.getState().selectedBlockId).toBe(block.id);
    expect(host.contains(color)).toBe(true);
    await act(async () => { button('Bold').click(); });
    expect(useEditingStore.getState().selectedBlockId).toBe(block.id);
    expect(useEditingStore.getState().textEdits[0].layout?.fontName).toBe('Helvetica-Bold');
  });
});
