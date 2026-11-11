// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageToolbar } from '../../src/components/ImageToolbar/ImageToolbar';
import { useAnnotationStore } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import type { ImageAnnotation } from '../../src/annotations/types';

const image: ImageAnnotation = {
  id: 'img-1', type: 'image', pageNumber: 1, createdAt: new Date(0), modifiedAt: new Date(0), color: '#000000', opacity: 1,
  rect: [10, 10, 100, 50], imageData: 'data:image/png;base64,aGVsbG8=', originalWidth: 200, originalHeight: 100, rotation: 0,
  flipHorizontal: false, flipVertical: false, borderWidth: 0, borderColor: '#000000', borderStyle: 'none', borderRadius: 0,
  lockAspectRatio: true, isLocked: false, zIndex: 0,
};
function Connected() {
  const annotation = useAnnotationStore(state => state.annotations.get(1)?.find(item => item.id === image.id)) as ImageAnnotation | undefined;
  return annotation ? <ImageToolbar annotation={annotation} /> : null;
}
let root: Root, host: HTMLDivElement;
const recordUpdate = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAnnotationStore.setState({ annotations: new Map([[1, [{ ...image }]]]) });
  useAnnotationHistoryStore.setState({ recordUpdate });
  recordUpdate.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const slider = () => host.querySelector<HTMLInputElement>('input[type="range"][aria-label="Opacity"]')!;
async function slide(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), value);
    slider().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('image toolbar', () => {
  it('labels every icon button for assistive technology', async () => {
    await act(async () => root.render(<Connected />));
    const names = [...host.querySelectorAll('button')].map(button => button.getAttribute('aria-label'));
    expect(names).toEqual(['Flip Horizontal', 'Flip Vertical', 'Rotate Left 90°', 'Rotate Right 90°', 'Crop Image', 'Bring to Front', 'Send to Back', 'Bring Forward', 'Send Backward', 'Delete Image']);
    expect(host.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Image');
  });
  it('previews opacity live and records one undo step per slider gesture', async () => {
    await act(async () => root.render(<Connected />));
    await slide('0.8'); await slide('0.5'); await slide('0.4');
    expect(useAnnotationStore.getState().annotations.get(1)![0].opacity).toBe(0.4);
    expect(host.textContent).toContain('40%');
    expect(recordUpdate).not.toHaveBeenCalled();
    await act(async () => { slider().dispatchEvent(new Event('pointerup', { bubbles: true })); });
    expect(recordUpdate).toHaveBeenCalledTimes(1);
    const [next, previous] = recordUpdate.mock.calls[0] as [ImageAnnotation, ImageAnnotation];
    expect(previous.opacity).toBe(1);
    expect(next.opacity).toBe(0.4);
    // A release without a change does not add an empty step.
    await act(async () => { slider().dispatchEvent(new Event('pointerup', { bubbles: true })); slider().dispatchEvent(new FocusEvent('blur')); });
    expect(recordUpdate).toHaveBeenCalledTimes(1);
  });
});
