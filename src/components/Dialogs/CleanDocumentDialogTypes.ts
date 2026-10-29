import type { CleanupControl, CleanupOptions, CleanupReport } from '../../core/DocumentCleanupTypes';

export interface CleanDocumentSource {
  data: ArrayBuffer;
  report?: CleanupReport;
  fileName: string;
  workspaceAnnotations: { count: number; pages: number[] };
  pendingRedactions: number;
  preparePreview: (cleaned: Uint8Array, options: CleanupOptions, signal: AbortSignal) => Promise<Uint8Array>;
  readVisiblePDF: (signal: AbortSignal) => Promise<ArrayBuffer>;
}
export interface CleanDocumentDialogProps {
  documentKey: unknown;
  revision: number;
  currentPage: number;
  readPDF: (signal: AbortSignal) => Promise<CleanDocumentSource>;
  onApply: (options: CleanupOptions, signal: AbortSignal, onCommit: () => void, onProgress?: CleanupControl['onProgress']) => Promise<void>;
  onClose: () => void;
}
