// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationStore } from '../../src/store/annotationStore';
import { useEditingStore } from '../../src/store/editingStore';
import { CombinedToolbar } from '../../src/components/Toolbar/CombinedToolbar';

class DelayedReader {
  static instances: DelayedReader[] = [];
  result: string | null = null;
  readyState = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL = vi.fn(() => { this.readyState = 1; });
  abort = vi.fn(() => { this.readyState = 2; this.onabort?.(); });
  constructor() { DelayedReader.instances.push(this); }
  complete(value = 'data:image/png;base64,aGVsbG8=') { this.result = value; this.readyState = 2; this.onload?.(); }
}
class DelayedImage {
  static instances: DelayedImage[] = [];
  naturalWidth = 200; naturalHeight = 80; src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { DelayedImage.instances.push(this); }
}
type Props = ComponentProps<typeof CombinedToolbar>;
let root: Root, host: HTMLDivElement, props: Props, mounted: boolean;
const png = (name = 'signature.png') => new File(['png'], name, { type: 'image/png' });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('FileReader', DelayedReader); vi.stubGlobal('Image', DelayedImage);
  useAnnotationStore.setState({ currentTool: 'select', customStamps: [] }); useEditingStore.setState({ mode: 'none' }); Reflect.deleteProperty(window, '__selectedStamp');
  DelayedReader.instances = []; DelayedImage.instances = []; mounted = true;
  props = { documentKey: 'doc-one', documentRevision: 1, hasDocument: true, currentPage: 1, totalPages: 3, selectedPages: [], canUndo: false, canRedo: false, canResetToOriginal: false,
    onRotatePages: vi.fn(), onDeletePages: vi.fn(), onInsertBlankPage: vi.fn(), onInsertFromFile: vi.fn(), onMerge: vi.fn(), onSplit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onResetToOriginal: vi.fn(), onCloseDocument: vi.fn(), onInsertImage: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(changes: Partial<Props> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<CombinedToolbar {...props} />)); }
async function select(files = [png()]) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Insert images"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function decode(index = 0) { await act(async () => DelayedReader.instances[index].complete()); await act(async () => DelayedImage.instances[index].onload?.()); }
async function click(name: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === name)!.click()); }

describe('image insertion lifecycle', () => {
  it('shows loading until reading and decoding finish, then inserts the complete batch in file order', async () => {
    await render(); await select([png('first.png'), png('second.png')]); expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading 2 images…'); expect(props.onInsertImage).not.toHaveBeenCalled();
    await act(async () => DelayedReader.instances[1].complete()); await act(async () => DelayedImage.instances[0].onload?.()); expect(props.onInsertImage).not.toHaveBeenCalled();
    await act(async () => DelayedReader.instances[0].complete()); await act(async () => DelayedImage.instances[1].onload?.());
    expect(props.onInsertImage).toHaveBeenCalledTimes(1); expect(vi.mocked(props.onInsertImage!).mock.calls[0][0].map(image => image.filename)).toEqual(['first.png', 'second.png']); expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it.each([{ documentKey: 'different' }, { documentRevision: 2 }, { isBusy: true }, { hasDocument: false }])('aborts old reads on document or operation change: %j', async changes => {
    await render(); await select(); const reader = DelayedReader.instances[0], delayed = reader.onload!; await render(changes); expect(reader.abort).toHaveBeenCalledTimes(1);
    await act(async () => { reader.result = 'data:image/png;base64,aGVsbG8='; delayed(); }); expect(DelayedImage.instances).toHaveLength(0); expect(props.onInsertImage).not.toHaveBeenCalled(); expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('rejects a late decoded image after document replacement and cleans up pending decoders', async () => {
    await render(); await select(); await act(async () => DelayedReader.instances[0].complete()); const image = DelayedImage.instances[0], delayed = image.onload!; await render({ documentKey: 'replacement' }); expect(image.src).toBe('');
    await act(async () => delayed()); expect(props.onInsertImage).not.toHaveBeenCalled();
  });
  it('a newer selection cancels the previous read without resetting or inserting the new input twice', async () => {
    await render(); await select([png('old.png')]); const old = DelayedReader.instances[0], delayed = old.onload!; await select([png('new.png')]); expect(old.abort).toHaveBeenCalledTimes(1);
    await act(async () => { old.result = 'data:image/png;base64,b2xk'; delayed(); }); await act(async () => DelayedReader.instances[1].complete()); await act(async () => DelayedImage.instances[0].onload?.());
    expect(props.onInsertImage).toHaveBeenCalledTimes(1); expect(vi.mocked(props.onInsertImage!).mock.calls[0][0][0].filename).toBe('new.png'); expect(host.querySelector<HTMLInputElement>('[aria-label="Insert images"]')!.value).toBe('');
  });
  it('explicit cancellation and unmount terminate pending work and ignore captured late handlers', async () => {
    await render(); await select(); const first = DelayedReader.instances[0], delayed = first.onload!; await click('Cancel image loading'); expect(first.abort).toHaveBeenCalledTimes(1); await act(async () => delayed()); expect(props.onInsertImage).not.toHaveBeenCalled();
    await select(); const second = DelayedReader.instances[1], late = second.onload!; await act(async () => root.unmount()); mounted = false; expect(second.abort).toHaveBeenCalledTimes(1); await act(async () => late()); expect(props.onInsertImage).not.toHaveBeenCalled();
  });
  it('shows read and decode errors without partial insertion and permits a successful retry', async () => {
    await render(); await select([png('good.png'), png('bad.png')]); await decode(0); await act(async () => DelayedReader.instances[1].onerror?.()); expect(props.onInsertImage).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('bad.png');
    await click('Dismiss image error'); expect(host.querySelector('[role="alert"]')).toBeNull(); await select([png('corrupt.png')]); await act(async () => DelayedReader.instances[2].complete()); await act(async () => DelayedImage.instances[1].onerror?.()); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not decode');
    await select([png('retry.png')]); await act(async () => DelayedReader.instances[3].complete()); await act(async () => DelayedImage.instances[2].onload?.()); expect(props.onInsertImage).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('rejects invalid types, excessive selection and dimensions before insertion', async () => {
    await render(); await select([new File(['x'], 'text.txt', { type: 'text/plain' })]); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Choose an image'); expect(DelayedReader.instances).toHaveLength(0);
    await select(Array.from({ length: 21 }, () => png())); expect(host.querySelector('[role="alert"]')?.textContent).toContain('up to 20'); expect(DelayedReader.instances).toHaveLength(0);
    const large = png(); Object.defineProperty(large, 'size', { value: 21 * 1024 * 1024 }); await select([large]); expect(host.querySelector('[role="alert"]')?.textContent).toContain('20 MB'); expect(DelayedReader.instances).toHaveLength(0);
    await select(); await act(async () => DelayedReader.instances[0].complete()); const image = DelayedImage.instances[0]; image.naturalWidth = 10000; image.naturalHeight = 10000; await act(async () => image.onload?.()); expect(host.querySelector('[role="alert"]')?.textContent).toContain('40 million pixels'); expect(props.onInsertImage).not.toHaveBeenCalled();
  });
  it('does not start reads while busy even if a stale file input event arrives', async () => {
    await render({ isBusy: true }); await select(); expect(DelayedReader.instances).toHaveLength(0); expect(props.onInsertImage).not.toHaveBeenCalled();
  });
});

async function selectStamp(file = png()) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Custom stamp image"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function stampMenu() { await act(async () => host.querySelector<HTMLButtonElement>('[title="Stamp"]')!.click()); }

describe('custom stamp loading and selection', () => {
  it('preserves image dimensions, activates the uploaded stamp and shows its selected state', async () => {
    await render(); await selectStamp(png('Official.png')); expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading stamp Official.png');
    await decode();
    expect(useAnnotationStore.getState().customStamps[0]).toMatchObject({ name: 'Official', width: 200, height: 80 });
    expect(useAnnotationStore.getState().currentTool).toBe('stamp'); expect(host.querySelector('[role="status"]')?.textContent).toContain('Stamp: Official');
    expect(host.querySelector('[data-toolbar-menu="stamp"]')).toBeNull(); await stampMenu();
    expect([...host.querySelectorAll('button[aria-pressed="true"]')].map(button => button.textContent)).toEqual(['Official']);
    await click('Approved'); expect(host.querySelector('[role="status"]')?.textContent).toContain('Stamp: Approved');
    await stampMenu(); expect([...host.querySelectorAll('button[aria-pressed="true"]')].map(button => button.textContent)).toEqual(['Approved']);
  });
  it('uses unique nonempty library names and normalizes non-PDF image formats', async () => {
    const draw = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,aGVsbG8=');
    await render(); await selectStamp(new File(['svg'], 'seal.svg', { type: 'image/svg+xml' }));
    await act(async () => DelayedReader.instances[0].complete('data:image/svg+xml;base64,c3Zn')); await act(async () => DelayedImage.instances[0].onload?.());
    expect(draw).toHaveBeenCalledOnce(); expect(useAnnotationStore.getState().customStamps[0].imageData).toContain('data:image/png;');
    await selectStamp(png('seal.png')); await decode(1);
    await selectStamp(png('.png')); await decode(2);
    expect(useAnnotationStore.getState().customStamps.map(stamp => stamp.name)).toEqual(['seal', 'seal (2)', 'Custom stamp']);
  });
  it('decodes legacy image-only library entries on selection without duplicating or losing them', async () => {
    useAnnotationStore.setState({ customStamps: [{ name: 'Legacy', imageData: 'data:image/png;base64,aGVsbG8=' }] });
    await render(); await stampMenu(); await click('Legacy'); await act(async () => DelayedReader.instances[0].complete());
    DelayedImage.instances[0].naturalWidth = 40; DelayedImage.instances[0].naturalHeight = 80; await act(async () => DelayedImage.instances[0].onload?.());
    expect(useAnnotationStore.getState().customStamps).toHaveLength(1);
    expect((window as unknown as { __selectedStamp: unknown }).__selectedStamp).toMatchObject({ name: 'Legacy', width: 40, height: 80 });
    await stampMenu(); expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe('Legacy');
  });
  it.each([{ documentKey: 'new' }, { documentRevision: 2 }, { isBusy: true }, { hasDocument: false }])('ignores stale custom stamp reads: %j', async changes => {
    await render(); await selectStamp(); const reader = DelayedReader.instances[0], late = reader.onload!; await render(changes); expect(reader.abort).toHaveBeenCalledOnce();
    await act(async () => late()); expect(useAnnotationStore.getState().customStamps).toHaveLength(0); expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('supports cancellation, rejects unreadable files and retries without adding broken entries', async () => {
    await render(); await selectStamp(); await click('Cancel image loading'); expect(DelayedReader.instances[0].abort).toHaveBeenCalledOnce();
    await selectStamp(new File(['text'], 'bad.txt', { type: 'text/plain' })); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Choose an image');
    await selectStamp(); await act(async () => DelayedReader.instances[1].complete()); await act(async () => DelayedImage.instances[0].onerror?.()); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not decode');
    expect(useAnnotationStore.getState().customStamps).toHaveLength(0); await selectStamp(); await act(async () => DelayedReader.instances[2].complete()); await act(async () => DelayedImage.instances[1].onload?.()); expect(useAnnotationStore.getState().customStamps).toHaveLength(1);
  });
  it('does not reactivate Stamp after the user switches tools while it loads', async () => {
    await render(); await selectStamp(); await act(async () => useAnnotationStore.getState().setCurrentTool('pan')); await decode();
    expect(useAnnotationStore.getState().currentTool).toBe('pan'); expect(useAnnotationStore.getState().customStamps).toHaveLength(0); expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe('toolbar disclosure menus', () => {
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-toolbar-menu-trigger="document"]')!;
  const menu = () => host.querySelector('[data-toolbar-menu="document"]');
  async function key(element: Element, key: string) { await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))); }
  it('opens with the keyboard, skips disabled buttons, navigates and restores focus on Escape', async () => {
    await render(); const outsideKey = vi.fn(); window.addEventListener('keydown', outsideKey);
    try {
      trigger().focus(); await key(trigger(), 'ArrowDown'); expect(trigger().getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement?.textContent).toBe('Edit objects');
      await key(document.activeElement!, 'ArrowDown'); expect(document.activeElement?.textContent).toBe('Edit Text');
      await key(document.activeElement!, 'ArrowDown'); expect(document.activeElement?.textContent).toBe('Edit Images');
      await key(document.activeElement!, 'End'); expect(document.activeElement?.textContent?.trim()).toBe('Close Document');
      await key(document.activeElement!, 'ArrowUp'); expect(document.activeElement?.textContent).toBe('Mark Content Areas');
      await key(document.activeElement!, 'Home'); expect(document.activeElement?.textContent).toBe('Edit objects');
      await key(document.activeElement!, 'Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(trigger()); expect(outsideKey).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', outsideKey); }
  });
  it('moves focus after native Enter activation and closes on focus leaving its disclosure', async () => {
    await render(); trigger().focus(); await key(trigger(), 'Enter'); await act(async () => trigger().click()); expect(document.activeElement?.textContent).toBe('Edit objects');
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Rectangle"]')!.focus()); expect(menu()).toBeNull();
  });
  it('keeps only one dropdown open and clamps its position to the viewport', async () => {
    await render(); vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue({ left: 4000, bottom: 900 } as DOMRect);
    await act(async () => trigger().click()); const popup = menu() as HTMLElement; expect(parseFloat(popup.style.getPropertyValue('--toolbar-menu-left'))).toBeLessThanOrEqual(window.innerWidth - 8); expect(parseFloat(popup.style.getPropertyValue('--toolbar-menu-top'))).toBeLessThan(window.innerHeight);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-toolbar-menu-trigger="stamp"]')!.click()); expect(menu()).toBeNull(); expect(host.querySelectorAll('[data-toolbar-menu]')).toHaveLength(1);
  });
});
