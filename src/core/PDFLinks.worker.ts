import { inspectPDFLinks } from './PDFLinks';
import { applyPDFLinksWorkspace, preparePDFLinksWorkspace, previewPDFLinksWorkspace } from './PDFLinksWorkspace';
import type { PDFLinkControl, PDFLinkOperation } from './PDFLinkTypes';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';

type Request = { job: 'inspect' | 'prepare' | 'preview' | 'apply'; data: ArrayBuffer; workspace: WorkspaceSnapshot; operations: PDFLinkOperation[]; expectedRevision?: string };
self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const { job, data, workspace, operations, expectedRevision } = event.data;
    const control: PDFLinkControl = { expectedRevision, onProgress: progress => self.postMessage({ type: 'progress', progress }) };
    const result = job === 'inspect' ? await inspectPDFLinks(data, control)
      : job === 'prepare' ? await preparePDFLinksWorkspace(data, workspace, control)
      : job === 'preview' ? await previewPDFLinksWorkspace(data, workspace, operations, control)
      : job === 'apply' ? await applyPDFLinksWorkspace(data, workspace, operations, control)
      : undefined;
    if (!result) throw new Error('Unknown PDF links operation.');
    const bytes = result instanceof Uint8Array ? result : 'data' in result ? result.data : undefined;
    self.postMessage({ type: 'result', result }, { transfer: bytes instanceof Uint8Array ? [bytes.buffer] : bytes instanceof ArrayBuffer ? [bytes] : [] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not edit PDF links.' });
  }
};
