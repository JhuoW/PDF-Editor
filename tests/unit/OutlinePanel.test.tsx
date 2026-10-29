// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { OutlinePanel } from '../../src/components/Sidebar/OutlinePanel';
import { getPDFOutline } from '../../src/core/PDFDocument';
vi.mock('../../src/utils/pdfConfig', () => ({ pdfjsLib: {}, pdfDocumentOptions: {} }));
const item = (title: string, dest: unknown = null, extra = {}) => ({ title, dest, bold: false, italic: false, color: new Uint8ClampedArray([0, 0, 0]), items: [], ...extra });
function pdf(items: unknown[]) { return { numPages: 3, getOutline: vi.fn(async () => items), getPageIndex: vi.fn(async () => 2), getDestination: vi.fn(async () => null) } as unknown as PDFDocumentProxy; }
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('bookmark reading and navigation', () => {
  it('retains full XYZ targets/styles, resolves integer pages, and never substitutes page one for groups or invalid names', async () => {
    const doc = pdf([item('Chapter', [2, { name: 'XYZ' }, 40, 300, 1.5], { bold: true, italic: true, color: [30, 50, 70] }), item('Group'), item('Missing', 'gone'), item('Unsafe', null, { url: 'javascript:alert(1)' })]);
    const result = await getPDFOutline(doc);
    expect(result[0]).toMatchObject({ pageNumber: 3, dest: [2, { name: 'XYZ' }, 40, 300, 1.5], bold: true, italic: true, color: '#1e3246' });
    expect(result.slice(1).every(node => node.pageNumber === undefined && node.dest === null)).toBe(true);
    expect(result[2].unsupportedReason).toMatch(/available/); expect(result[3].url).toBeUndefined();
  });
  it('opens a collapsed group without navigating and activates a child with its full destination', async () => {
    const destination = [2, { name: 'XYZ' }, 40, 300, 1.5], navigate = vi.fn(), manage = vi.fn();
    const doc = pdf([item('Group', null, { count: -1, items: [item('Child', destination)] }), item('Website', null, { url: 'https://example.com/' })]);
    await act(async () => root.render(<OutlinePanel document={doc} onNavigate={navigate} onManage={manage} />));
    expect(host.textContent).not.toContain('Child');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Group"]')!.click());
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Child'))!.click());
    expect(navigate).toHaveBeenCalledWith(destination);
    expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Manage…')!.click()); expect(manage).toHaveBeenCalledOnce();
  });
  it('does not display a delayed old document result after switching files', async () => {
    let finish!: (value: unknown[]) => void;
    const old = pdf([]); vi.mocked(old.getOutline).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<OutlinePanel document={old} onNavigate={vi.fn()} />));
    await act(async () => root.render(<OutlinePanel document={pdf([item('Current', [0, { name: 'Fit' }])])} onNavigate={vi.fn()} />));
    await act(async () => finish([item('Obsolete', [0, { name: 'Fit' }])]));
    expect(host.textContent).toContain('Current'); expect(host.textContent).not.toContain('Obsolete');
  });
  it('aborts an obsolete named lookup without continuing into its children', async () => {
    const controller = new AbortController(), doc = pdf([item('Named', 'chapter', { items: [item('Child', 'child')] })]);
    let finish!: (value: unknown) => void;
    vi.mocked(doc.getDestination).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = getPDFOutline(doc, controller.signal); await Promise.resolve(); await Promise.resolve();
    controller.abort(); finish([0, { name: 'Fit' }]); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(doc.getDestination).toHaveBeenCalledOnce();
  });
});
