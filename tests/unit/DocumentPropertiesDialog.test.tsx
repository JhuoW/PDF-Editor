// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPropertiesDialog, type DocumentPropertiesDialogProps } from '../../src/components/Dialogs/DocumentPropertiesDialog';
import type { DocumentMetadata } from '../../src/core/DocumentAssets';

const api = vi.hoisted(() => ({
  inspectDocumentAssets: vi.fn(), updateDocumentMetadata: vi.fn(), clearDocumentMetadata: vi.fn(),
  addDocumentAttachment: vi.fn(), removeDocumentAttachment: vi.fn(), extractDocumentAttachment: vi.fn(),
}));
vi.mock('../../src/core/DocumentAssets', () => api);
const blank: DocumentMetadata = { title: '', author: '', subject: '', keywords: '' };
const original = { title: 'Original title', author: 'Author', subject: 'Subject', keywords: 'one, two' };
const attachments = [
  { id: 'file-11', name: 'same.txt', description: 'First attachment', mimeType: 'text/plain', size: 3 },
  { id: 'file-22', name: 'same.txt', description: 'Second attachment', mimeType: 'text/plain', size: 5 },
];
let host: HTMLDivElement, root: Root, props: DocumentPropertiesDialogProps;
let anchorClick: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-download') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  api.inspectDocumentAssets.mockResolvedValue({ metadata: original, hasXmp: true, attachments });
  for (const operation of [api.updateDocumentMetadata, api.clearDocumentMetadata, api.addDocumentAttachment, api.removeDocumentAttachment]) operation.mockResolvedValue(new Uint8Array([2]));
  props = {
    isOpen: true, documentKey: 'first-document', revision: 1, onClose: vi.fn(),
    readPDF: vi.fn(async () => new Uint8Array([1]).buffer),
    onApply: vi.fn(async (_label, transform) => { await transform(new Uint8Array([1]).buffer); }),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  anchorClick.mockRestore();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(changes: Partial<DocumentPropertiesDialogProps> = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<DocumentPropertiesDialog {...props} />));
}
function button(text: string) { return [...host.querySelectorAll('button')].find(element => element.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectFile(file: File) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Attachment file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

describe('DocumentPropertiesDialog', () => {
  it('opens a modal, focuses the title, distinguishes same-name attachments and restores focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener); opener.focus();
    await render();
    expect(host.querySelector('dialog')?.open).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Document title');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.textContent).toContain('First attachment');
    expect(host.textContent).toContain('Second attachment');
    expect(host.textContent).toContain('catalog XMP');
    expect(host.textContent).toContain('does not remove sensitive information');
    await render({ isOpen: false });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('saves and clears metadata through undoable transforms, retaining the draft after a failure', async () => {
    await render();
    await fill('Document title', '中文 title');
    api.updateDocumentMetadata.mockRejectedValueOnce(new Error('Could not update metadata'));
    await click('Save properties');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not update metadata');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('中文 title');
    expect(button('Save properties').disabled).toBe(false);
    api.inspectDocumentAssets.mockResolvedValue({ metadata: { ...original, title: '中文 title' }, hasXmp: false, attachments });
    await click('Save properties');
    expect(props.onApply).toHaveBeenLastCalledWith('Update document properties', expect.any(Function));
    expect(api.updateDocumentMetadata).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), { ...original, title: '中文 title' });
    expect(button('Save properties').disabled).toBe(true);
    api.inspectDocumentAssets.mockResolvedValue({ metadata: blank, hasXmp: false, attachments });
    await click('Clear document metadata');
    expect(api.clearDocumentMetadata).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('');
  });

  it('deletes only the selected attachment ID and downloads exact bytes from its sibling', async () => {
    await render();
    api.inspectDocumentAssets.mockResolvedValue({ metadata: original, hasXmp: true, attachments: [attachments[0]] });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete attachment 2: same.txt"]')!.click());
    expect(api.removeDocumentAttachment).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'file-22');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    api.extractDocumentAttachment.mockResolvedValue({ name: 'same.txt', mimeType: 'text/plain', data: new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4) });
    await click('Download');
    expect(api.extractDocumentAttachment).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'file-11');
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: 3, type: 'text/plain' }));
    expect(anchorClick).toHaveBeenCalledTimes(1);
  });

  it('preserves pending property and file drafts while refreshing revision-specific attachment IDs', async () => {
    await render();
    await fill('Document title', 'Unsaved draft');
    const file = new File(['file bytes'], 'pending.txt', { type: 'text/plain' });
    await selectFile(file);
    await fill('Attachment description', 'Keep this description');
    api.inspectDocumentAssets.mockResolvedValue({ metadata: original, hasXmp: true, attachments: [{ ...attachments[0], id: 'new-ref' }] });
    await render({ revision: 2 });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('Unsaved draft');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Attachment description"]')?.value).toBe('Keep this description');
    expect(button('Add attachment').disabled).toBe(false);
    await click('Delete');
    expect(api.removeDocumentAttachment).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'new-ref');
  });

  it('blocks duplicate file submissions and Escape while busy, then discards an old-document file read', async () => {
    let finishFile!: (data: ArrayBuffer) => void;
    const file = new File(['old bytes'], 'old.txt');
    const arrayBuffer = vi.fn(() => new Promise<ArrayBuffer>(resolve => { finishFile = resolve; }));
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
    await render();
    await selectFile(file);
    await click('Add attachment');
    await click('Add attachment');
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(button('Close').disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => host.querySelector('dialog')!.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    api.inspectDocumentAssets.mockResolvedValue({ metadata: { ...blank, title: 'New document' }, hasXmp: false, attachments: [] });
    await render({ documentKey: 'replacement-document', revision: 2 });
    await act(async () => finishFile(new Uint8Array([7]).buffer));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(api.addDocumentAttachment).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('New document');
  });

  it('ignores an old load and refuses a download when the PDF revision changes', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof api.inspectDocumentAssets>>) => void;
    api.inspectDocumentAssets.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    await render();
    await render({ documentKey: 'new-document', revision: 2 });
    await act(async () => resolveOld({ metadata: { ...blank, title: 'Wrong old title' }, hasXmp: false, attachments: [] }));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('Original title');
    let finishDownload!: (data: ArrayBuffer) => void;
    vi.mocked(props.readPDF).mockImplementationOnce(() => new Promise(resolve => { finishDownload = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Download attachment 1: same.txt"]')!.click());
    await render({ revision: 3 });
    await act(async () => finishDownload(new Uint8Array([1]).buffer));
    expect(api.extractDocumentAttachment).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('rejects an old metadata transform before its caller can commit to a replacement document', async () => {
    let finishTransform!: (data: Uint8Array) => void;
    api.updateDocumentMetadata.mockReturnValue(new Promise(resolve => { finishTransform = resolve; }));
    const committed = vi.fn();
    await render({ onApply: async (_label, transform) => { committed(await transform(new Uint8Array([1]).buffer)); } });
    await fill('Document title', 'Old draft');
    await click('Save properties');
    api.inspectDocumentAssets.mockResolvedValue({ metadata: { ...blank, title: 'Replacement' }, hasXmp: false, attachments: [] });
    await render({ documentKey: 'replacement', revision: 2 });
    await act(async () => finishTransform(new Uint8Array([2])));
    expect(committed).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Document title"]')?.value).toBe('Replacement');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
