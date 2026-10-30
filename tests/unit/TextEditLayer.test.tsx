// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEditLayer } from '../../src/components/PDFViewer/TextEditLayer';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { commitPendingEditors } from '../../src/store/workspaceHistory';
import type { TextBlock } from '../../src/editing/types';
import { INVISIBLE_TEXT_EDIT_REASON } from '../../src/editing/types';

const { detectTextBlocks } = vi.hoisted(() => ({ detectTextBlocks: vi.fn() }));
vi.mock('../../src/editing/TextBlockDetector', () => ({ detectTextBlocks }));
vi.mock('../../src/components/PDFViewer/InlinePDFPreview', () => ({ InlinePDFPreview: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block: TextBlock = {
  id: 'block-1-0', pageNumber: 1, text: 'Original', editable: true, lines: [],
  rect: { x: 10, y: 20, width: 100, height: 30 },
  style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 },
};
let container: HTMLDivElement;
let root: Root;

function page(rotate = 0) {
  return {
    rotate,
    getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => ({
      convertToPdfPoint: (x: number, y: number) => [x / scale + 50, 600 - y / scale],
      convertToViewportPoint: (x: number, y: number) => rotation === 90
        ? [(600 - y) * scale, (x - 50) * scale]
        : [(x - 50) * scale, (600 - y) * scale],
    }),
  } as unknown as PDFPageProxy;
}

async function render(pdfPage: PDFPageProxy, scale = 1, onTextLayout?: (blockId: string) => void) {
  await act(async () => root.render(<TextEditLayer page={pdfPage} pageNumber={1} scale={scale} rotation={0} onTextLayout={onTextLayout} />));
}

beforeEach(() => {
  vi.resetAllMocks();
  useHistoryStore.setState(useHistoryStore.getInitialState(), true);
  useEditingStore.setState(useEditingStore.getInitialState(), true);
  useEditingStore.getState().setMode('text');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('text editing interaction', () => {
  it('opens the requested object block for direct typing without a second click', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    useEditingStore.getState().requestTextEdit(block.id);
    await render(page());
    expect(container.querySelector('textarea')?.value).toBe('Original');
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    expect(useEditingStore.getState().pendingTextEditId).toBeNull();
    expect(useEditingStore.getState().textEdits).toEqual([]);
  });

  it('keeps a moved text object at its translated position when direct typing starts', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    const targetRect = { ...block.rect, x: 110, y: 120 };
    useEditingStore.getState().updateBlockLayout({ blockId: block.id, originalText: block.text, newText: block.text, timestamp: 1,
      layout: { targetRect, translate: true, keepBaseline: true } });
    useEditingStore.getState().requestTextEdit(block.id);
    await render(page());
    expect(container.querySelector<HTMLElement>('.pdf-text-caret')?.style.left).toBe('110px');
    expect(container.querySelector<HTMLElement>('.pdf-text-caret')?.style.top).toBe('120px');
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Changed');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useEditingStore.getState().textEdits[0].layout).toMatchObject({ targetRect, translate: true });
  });

  it('does not clear an image selection when an inactive text layer is flushed for export', async () => {
    useEditingStore.getState().setMode('image');
    useEditingStore.getState().selectImage('image-1');
    await render(page());
    act(() => commitPendingEditors());
    expect(useEditingStore.getState().selectedImageId).toBe('image-1');
  });

  it('preserves a newly selected image after switching away from an active text edit', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]); await render(page());
    act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    act(() => { useEditingStore.getState().setMode('image'); useEditingStore.getState().selectImage('image-2'); });
    act(() => commitPendingEditors());
    expect(useEditingStore.getState().selectedImageId).toBe('image-2');
  });
  it('keeps invisible OCR blocks read-only in both the UI and editing store', async () => {
    useEditingStore.getState().setTextBlocks(1, [{ ...block, editable: false, unsupportedReason: INVISIBLE_TEXT_EDIT_REASON }]);
    await render(page());
    const element = container.querySelector<HTMLElement>('.text-block')!;
    act(() => { element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(container.querySelector('textarea')).toBeNull();
    expect(element.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('use search or copy instead');
    act(() => useEditingStore.getState().updateBlockText(block.id, 'Unsafe replacement'));
    expect(useEditingStore.getState().getBlock(block.id)?.text).toBe('Original');
    expect(useEditingStore.getState().textEdits).toEqual([]);
    act(() => container.querySelector<HTMLButtonElement>('.text-edit-readonly button')!.click());
    expect(useEditingStore.getState().mode).toBe('none');
    expect(container.querySelector('.text-edit-layer')).toBeNull();
  });

  it('saves an empty string as a deletion', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    await render(page());
    act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
    expect(useEditingStore.getState().textBlocks.get(1)?.[0].text).toBe('');
    expect(useEditingStore.getState().textEdits[0].newText).toBe('');
  });

  it('keeps composition Enter and Escape inside the editor, then finishes with Ctrl+Enter', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    await render(page());
    act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '中文候选');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const key of ['Enter', 'Escape']) {
      act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })));
      expect(container.querySelector('textarea')).toBe(textarea);
      expect(useEditingStore.getState().getBlock(block.id)?.text).toBe('中文候选');
    }
    // Safari-like final composition events can use 229 without isComposing.
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })));
    expect(container.querySelector('textarea')).toBe(textarea);
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(container.querySelector('textarea')).toBeNull();
    expect(useEditingStore.getState().getBlock(block.id)?.text).toBe('中文候选');
    expect(useEditingStore.getState().textEdits).toHaveLength(1);
  });

  it('cancels only the current typing session with Escape and preserves an earlier saved edit', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    await render(page());
    const type = (value: string) => {
      const textarea = container.querySelector('textarea')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return textarea;
    };
    act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const first = type('Saved edit');
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const second = type('Discard this session');
    act(() => second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('textarea')).toBeNull();
    expect(useEditingStore.getState().getBlock(block.id)?.text).toBe('Saved edit');
    expect(useEditingStore.getState().textEdits.at(-1)?.newText).toBe('Saved edit');
  });

  it('edits short glyph regions without expanding their original bounds or displaying a text box', async () => {
    const short = { ...block, rect: { x: 10, y: 20, width: 100, height: 8 }, style: { ...block.style, fontSize: 10 } };
    useEditingStore.getState().setTextBlocks(1, [short]);
    await render(page());
    const element = container.querySelector<HTMLElement>('.text-block')!;
    expect(element.style.height).toBe('8px');
    act(() => element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(element.style.minHeight).toBe('');
    expect(container.querySelector('textarea')?.className).toBe('pdf-text-input');
    expect(useEditingStore.getState().getBlock(block.id)?.rect).toEqual(short.rect);
    const textarea = container.querySelector('textarea')!;
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    expect(element.style.minHeight).toBe('');
    expect(element.style.height).toBe('8px');
    expect(useEditingStore.getState().textEdits).toEqual([]);
  });

  it('includes native rotation and viewport offsets when positioning edit blocks', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    await render(page(90), 2);
    const element = container.querySelector<HTMLElement>('.text-block')!;
    expect(element.style.left).toBe('40px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('60px');
    expect(element.style.height).toBe('200px');
  });

  it('ignores text detection completed after a different PDF page is mounted', async () => {
    let finishOld!: (blocks: TextBlock[]) => void;
    const oldDetection = new Promise<TextBlock[]>(resolve => { finishOld = resolve; });
    detectTextBlocks.mockReturnValueOnce(oldDetection).mockResolvedValueOnce([{ ...block, id: 'new-document', text: 'New document' }]);
    await render(page());
    await render(page());
    await act(async () => { finishOld([block]); });
    expect(useEditingStore.getState().textBlocks.get(1)?.[0].id).toBe('new-document');
    expect(container.textContent).toContain('New document');
    expect(container.textContent).not.toContain('Original');
  });

  it('opens layout from the inline editor with its live text and remains keyboard accessible after blur', async () => {
    const openLayout = vi.fn(); useEditingStore.getState().setTextBlocks(1, [block]);
    await render(page(), 1, openLayout); act(() => container.querySelector<HTMLElement>('.text-block')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const textarea = container.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Draft paragraph'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.text-edit-actions button')).find(button => button.textContent === 'Text layout…')!;
    act(() => button.focus());
    expect(container.querySelector('textarea')).toBeNull(); expect(document.activeElement).toBe(button); expect(useEditingStore.getState().selectedBlockId).toBe(block.id);
    act(() => button.click()); expect(openLayout).toHaveBeenCalledWith(block.id); expect(useEditingStore.getState().getBlock(block.id)?.text).toBe('Draft paragraph');
  });

  it('positions the editable overlay at a layout target without changing the original removal rectangle', async () => {
    useEditingStore.getState().setTextBlocks(1, [block]);
    useEditingStore.setState({ textEdits: [{ blockId: block.id, originalText: 'Original', newText: 'Original', timestamp: 1, layout: { targetRect: { x: 50, y: 70, width: 200, height: 80 }, fontSize: 24, fontColor: '#123456', alignment: 'right', lineHeight: 1.5 } }] });
    await render(page(), 2, vi.fn());
    const element = container.querySelector<HTMLElement>('.text-block')!;
    expect(element.style.left).toBe('100px'); expect(element.style.top).toBe('140px'); expect(element.style.width).toBe('400px');
    act(() => element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))); const textarea = container.querySelector('textarea')!;
    expect(textarea.className).toBe('pdf-text-input');
    expect(useEditingStore.getState().getBlock(block.id)?.rect).toEqual({ x: 10, y: 20, width: 100, height: 30 });
  });
});
