import type { TextBlock, TextEditOperation } from '../../editing/types';

export interface TextLayoutSource {
  data: ArrayBuffer;
  block: TextBlock;
  edit?: TextEditOperation;
  preview: (edit: TextEditOperation, signal: AbortSignal) => Promise<Uint8Array>;
}
export interface TextLayoutDialogProps {
  documentKey: unknown;
  revision: number;
  blockId: string;
  readPDF: (signal: AbortSignal) => Promise<TextLayoutSource>;
  onSave: (edit: TextEditOperation, signal: AbortSignal) => Promise<void> | void;
  onClose: () => void;
}
