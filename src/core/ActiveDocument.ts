import { useDocumentStore } from '../store/documentStore';
import { useDocumentSessionStore } from '../store/documentSession';

/** Read the visible document, even if another tab has replaced the recovery cache. */
export async function readActivePDF(): Promise<{ data: ArrayBuffer; fileName: string }> {
  const initial = useDocumentStore.getState();
  if (!initial.document) throw new Error('No PDF loaded');
  const fileName = useDocumentSessionStore.getState().active?.fileName ?? 'document.pdf';
  const data = new Uint8Array(await initial.document.getData()).buffer;
  const current = useDocumentStore.getState();
  if (current.document !== initial.document || current.documentVersion !== initial.documentVersion
    || current.loadRequestId !== initial.loadRequestId) {
    throw new Error('Document changed while its content was being read');
  }
  return { data, fileName };
}
