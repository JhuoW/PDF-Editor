import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
export type PDFExportStage = 'prepare' | 'validate' | 'forms' | 'images' | 'text' | 'annotations' | 'complete';
export interface PDFExportProgress { stage: PDFExportStage; progress: number }
export interface PDFExportControl { signal?: AbortSignal; onProgress?: (progress: PDFExportProgress) => void }
export interface PDFExportRequest { job: 'export' | 'check'; data: ArrayBuffer; workspace: WorkspaceSnapshot }
export function exportProgress(control: PDFExportControl, stage: PDFExportStage, progress: number) {
  control.signal?.throwIfAborted(); control.onProgress?.({ stage, progress }); control.signal?.throwIfAborted();
}
