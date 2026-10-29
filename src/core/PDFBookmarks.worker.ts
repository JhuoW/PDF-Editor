import { inspectPDFBookmarks } from './PDFBookmarks';
import { applyPDFBookmarksWorkspace, preparePDFBookmarksWorkspace, previewPDFBookmarksWorkspace } from './PDFBookmarksWorkspace';
import type { PDFBookmarkControl, PDFBookmarkDraft } from './PDFBookmarksTypes';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';

type Request = { job: 'inspect' | 'prepare' | 'preview' | 'apply'; data: ArrayBuffer; workspace: WorkspaceSnapshot; tree: PDFBookmarkDraft[]; expectedRevision?: string };
self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const { job, data, workspace, tree, expectedRevision } = event.data;
    const control: PDFBookmarkControl = { expectedRevision, onProgress: progress => self.postMessage({ type: 'progress', progress }) };
    const result = job === 'inspect' ? await inspectPDFBookmarks(data, control)
      : job === 'prepare' ? await preparePDFBookmarksWorkspace(data, workspace, control)
      : job === 'preview' ? await previewPDFBookmarksWorkspace(data, workspace, tree, control)
      : job === 'apply' ? await applyPDFBookmarksWorkspace(data, workspace, tree, control)
      : undefined;
    if (!result) throw new Error('Unknown PDF bookmarks operation.');
    const bytes = result instanceof Uint8Array ? result : 'data' in result ? result.data : undefined;
    self.postMessage({ type: 'result', result }, { transfer: bytes instanceof Uint8Array ? [bytes.buffer] : bytes instanceof ArrayBuffer ? [bytes] : [] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not edit PDF bookmarks.' });
  }
};
