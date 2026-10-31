// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useSearchDocument } from '../../src/hooks/useSearchDocument';
import { exportWorkspacePDFInWorker } from '../../src/core/PDFExportClient';
import { pdfjsLib } from '../../src/utils/pdfConfig';
import { useEditingStore } from '../../src/store/editingStore';
import { useAnnotationStore } from '../../src/store/annotationStore';
import { useFormStore } from '../../src/store/formStore';
import type { SearchDocumentState } from '../../src/utils/searchDocumentContext';
import { textLayerGeometry } from '../../src/utils/textLayerGeometry';

vi.mock('../../src/utils/pdfConfig', () => ({ pdfDocumentOptions: {}, pdfjsLib: { getDocument: vi.fn() } }));
vi.mock('../../src/core/PDFExportClient', () => ({ exportWorkspacePDFInWorker: vi.fn() }));
let root: Root, host: HTMLElement, current: SearchDocumentState;
const source = () => ({ getData: vi.fn().mockResolvedValue(new Uint8Array([1])), numPages: 1 }) as unknown as PDFDocumentProxy;
function Render({ pdf, enabled = true }: { pdf: PDFDocumentProxy; enabled?: boolean }) { const state = useSearchDocument(pdf, enabled); useEffect(() => { current = state; }, [state]); return null; }
async function render(pdf: PDFDocumentProxy, enabled = true) { await act(async () => root.render(<Render pdf={pdf} enabled={enabled} />)); }
async function tick() { await act(async () => vi.advanceTimersByTimeAsync(250)); }
function edits(text: string) { useEditingStore.setState({ textEdits: [{ blockId: 'b', originalText: 'old', newText: text, timestamp: 1 }] }); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); vi.resetAllMocks();
  useEditingStore.getState().clearAll(); useAnnotationStore.setState({ annotations: new Map() }); useFormStore.setState({ fields: [], isDirty: false });
  vi.mocked(exportWorkspacePDFInWorker).mockResolvedValue(new Uint8Array([2]));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('avoids exports for unedited PDFs and destroys only owned search documents on close', async () => {
  const pdf = source(), derived = source(), destroy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({ promise: Promise.resolve(derived), destroy } as never);
  await render(pdf); await tick(); expect(current.document).toBe(pdf); expect(exportWorkspacePDFInWorker).not.toHaveBeenCalled();
  await act(async () => edits('中文')); expect(current.ready).toBe(false); expect(current.document).toBeNull(); await tick();
  expect(current.document).toBe(derived); expect(current.ready).toBe(true);
  expect(vi.mocked(exportWorkspacePDFInWorker).mock.calls[0][1].editing.textEdits[0].newText).toBe('中文');
  await render(pdf, false); expect(destroy).toHaveBeenCalledOnce(); expect(current.document).toBe(pdf);
  await render(pdf, true); expect(current.document).toBeNull(); expect(current.ready).toBe(false); await tick(); expect(exportWorkspacePDFInWorker).toHaveBeenCalledTimes(2);
});
it('cancels stale edit exports and never publishes bytes from an older edit or document', async () => {
  const pdf = source(), derived = source(); let resolveOld!: (bytes: Uint8Array<ArrayBuffer>) => void;
  vi.mocked(exportWorkspacePDFInWorker).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({ promise: Promise.resolve(derived), destroy: vi.fn().mockResolvedValue(undefined) } as never);
  edits('旧文字'); await render(pdf); await tick();
  const signal = vi.mocked(exportWorkspacePDFInWorker).mock.calls[0][2]!.signal!;
  await act(async () => edits('新文字')); expect(signal.aborted).toBe(true); await tick(); expect(current.document).toBe(derived);
  await act(async () => resolveOld(new Uint8Array([99]))); expect(current.document).toBe(derived); expect(pdfjsLib.getDocument).toHaveBeenCalledOnce();
  const other = source(); await render(other); expect(current.document).toBeNull(); expect(current.ready).toBe(false);
});
it('reports invalid pending layout without falling back to old text, then retries the current edit', async () => {
  const pdf = source(), cause = new Error('Text does not fit'), derived = source();
  vi.mocked(exportWorkspacePDFInWorker).mockRejectedValueOnce(cause);
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({ promise: Promise.resolve(derived), destroy: vi.fn().mockResolvedValue(undefined) } as never);
  edits('changed'); await render(pdf); await tick(); expect(current.document).toBeNull(); expect(current.error).toBe(cause);
  await act(async () => current.retry()); await tick(); expect(current.document).toBe(derived); expect(current.error).toBeUndefined();
  await act(async () => useEditingStore.setState({ textEdits: [] })); expect(current.document).toBe(pdf);
});
it('places highlights using cropped, scaled and rotated page coordinates', () => {
  const item = { transform: [12, 0, 0, 12, 60, 480], width: 24, height: 12 };
  const normal = textLayerGeometry(item, { transform: [2, 0, 0, -2, -40, 1160] }, { ascent: .75 });
  expect(normal).toEqual({ left: 80, top: 182, height: 24, angle: 0, width: 48 });
  const rotated = textLayerGeometry(item, { transform: [0, 2, 2, 0, -60, -40] }, { ascent: .75 });
  expect(rotated.left).toBeCloseTo(918); expect(rotated.top).toBeCloseTo(80); expect(rotated.angle).toBeCloseTo(Math.PI / 2); expect(rotated.width).toBe(48);
});
