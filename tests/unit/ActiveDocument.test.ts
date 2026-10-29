import { beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { readActivePDF } from '../../src/core/ActiveDocument';
import { useDocumentStore } from '../../src/store/documentStore';
import { useDocumentSessionStore } from '../../src/store/documentSession';

beforeEach(() => {
  useDocumentStore.setState(useDocumentStore.getInitialState());
  useDocumentSessionStore.setState({ active: null });
});

it('exports bytes owned by the visible PDF rather than a recovery record from another tab', async () => {
  const getData = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
  useDocumentStore.getState().setDocument({ numPages: 1, getData } as unknown as PDFDocumentProxy);
  useDocumentSessionStore.setState({ active: { sessionId: 'visible-session', fileName: 'visible.pdf' } });
  const result = await readActivePDF();
  expect(result.fileName).toBe('visible.pdf');
  expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
  expect(getData).toHaveBeenCalledOnce();
});

it('rejects a stale read when another open starts before it finishes', async () => {
  let finish!: (data: Uint8Array) => void;
  const getData = () => new Promise<Uint8Array>(resolve => { finish = resolve; });
  useDocumentStore.getState().setDocument({ numPages: 1, getData } as unknown as PDFDocumentProxy);
  const pending = readActivePDF();
  useDocumentStore.getState().beginLoadRequest();
  finish(new Uint8Array([1]));
  await expect(pending).rejects.toThrow('Document changed');
});
