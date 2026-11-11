// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PendingImageData } from '../../src/utils/readInsertImage';
import { ImagePropertiesPanel } from '../../src/components/ImageToolbar/ImagePropertiesPanel';
import { useAnnotationStore, createImageAnnotation } from '../../src/store/annotationStore';
import { useDocumentStore } from '../../src/store/documentStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';

const reads = vi.hoisted(() => [] as { signal: AbortSignal; resolve: (value: PendingImageData) => void; reject: (error: Error) => void }[]);
vi.mock('../../src/utils/readInsertImage', () => ({ readInsertImage: (_file: File, signal: AbortSignal) => new Promise<PendingImageData>((resolve, reject) => reads.push({ signal, resolve, reject })) }));
let host: HTMLDivElement, root: Root;
const image = () => useAnnotationStore.getState().getAllAnnotations()[0];
function Panel() { const annotations = useAnnotationStore(state => state.annotations); const annotation = annotations.get(1)![0]; return annotation.type === 'image' ? <ImagePropertiesPanel annotation={annotation} onClose={() => {}} /> : null; }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__APP_VERSION__', 'test'); reads.length = 0;
  useDocumentStore.setState({ document: null, documentVersion: 1 });
  useAnnotationStore.setState({ annotations: new Map([[1, [createImageAnnotation(1, [10, 20, 100, 70], 'data:image/png;base64,original', 100, 70)]]]) });
  vi.spyOn(useAnnotationHistoryStore.getState(), 'recordUpdate');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Panel />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function select() { const input = host.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'new.webp', { type: 'image/webp' })] }); await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); }
const normalized = { imageData: 'data:image/png;base64,converted', originalWidth: 80, originalHeight: 40, filename: 'new.webp', fileSize: 100, mimeType: 'image/png' };
it('uses canonical image data and retains geometry changed while replacement was decoding', async () => {
  await select(); const original = image(); await act(async () => useAnnotationStore.getState().updateAnnotation(original.id, { rect: [12, 22, 120, 84] }));
  await act(async () => reads[0].resolve(normalized));
  expect(image()).toMatchObject({ rect: [12, 22, 120, 84], imageData: normalized.imageData, mimeType: 'image/png', originalFilename: 'new.webp' });
  expect(useAnnotationHistoryStore.getState().recordUpdate).toHaveBeenCalledTimes(1);
});
it('does not apply a late replacement after the current PDF changes', async () => {
  const before = image(); await select(); await act(async () => useDocumentStore.setState({ documentVersion: 2 }));
  expect(reads[0].signal.aborted).toBe(true); await act(async () => reads[0].resolve(normalized)); expect(image()).toEqual(before);
  expect(useAnnotationHistoryStore.getState().recordUpdate).not.toHaveBeenCalled();
});
it('a second file selection cancels the first without allowing a late result to overwrite it', async () => {
  await select(); await select(); expect(reads[0].signal.aborted).toBe(true);
  await act(async () => reads[1].resolve(normalized)); await act(async () => reads[0].resolve({ ...normalized, imageData: 'data:image/png;base64,stale' }));
  expect(image()).toMatchObject({ imageData: normalized.imageData }); expect(useAnnotationHistoryStore.getState().recordUpdate).toHaveBeenCalledTimes(1);
});
it('switching to another image cancels decoding and leaves the new replacement action usable', async () => {
  await select();
  const second = createImageAnnotation(1, [120, 30, 80, 50], 'data:image/png;base64,second', 80, 50);
  await act(async () => useAnnotationStore.setState({ annotations: new Map([[1, [second, image()]]]) }));
  expect(reads[0].signal.aborted).toBe(true);
  const replaceButton = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Replace Image');
  expect(replaceButton).toBeDefined(); expect(replaceButton!.disabled).toBe(false);
  await act(async () => reads[0].resolve(normalized)); expect(image()).toEqual(second);
});
