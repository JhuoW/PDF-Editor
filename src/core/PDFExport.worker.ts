import { exportWorkspacePDF, inspectWorkspaceText } from './PDFExport';
import type { PDFExportProgress, PDFExportRequest } from './PDFExportTypes';
import { TextCheckError } from '../editing/TextCheckTypes';

self.onmessage = async (event: MessageEvent<PDFExportRequest>) => {
  try {
    const { job, data, workspace } = event.data;
    if (!(data instanceof ArrayBuffer) || !data.byteLength) throw new Error('The PDF source is empty.');
    const control = { onProgress: (progress: PDFExportProgress) => self.postMessage({ type: 'progress', progress }) };
    if (job === 'export') {
      const result = new Uint8Array(await exportWorkspacePDF(data, workspace, control));
      self.postMessage({ type: 'result', result }, { transfer: [result.buffer] });
    } else if (job === 'check') self.postMessage({ type: 'result', result: await inspectWorkspaceText(data, workspace, control) });
    else throw new Error('Unknown PDF operation.');
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error),
      issues: error instanceof TextCheckError ? error.issues : undefined });
  }
};
