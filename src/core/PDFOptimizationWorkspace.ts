import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { inspectPDFOptimizationInWorker } from './PDFOptimizerClient';
import { exportWorkspacePDF } from './PDFExport';

/** Export a snapshot for compression without changing the open document or history. */
export async function prepareOptimizationPDF(data: ArrayBuffer, workspace: WorkspaceSnapshot, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (workspace.editing.redactions.some(area => !area.applied)) {
    throw new Error('Apply or discard the pending content-removal areas before compressing this PDF.');
  }
  // Inspect the original bytes before a form writer can normalize XFA or a signature.
  const inspection = await inspectPDFOptimizationInWorker(data, { signal });
  signal?.throwIfAborted();
  if (!inspection.canOptimize) throw new Error(inspection.unsupportedReason || 'This PDF cannot be compressed safely.');
  const prepared = await exportWorkspacePDF(data, workspace);
  signal?.throwIfAborted();
  return new Uint8Array(prepared).buffer;
}
