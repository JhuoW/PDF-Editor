export interface CompressPDFSource {
  data: ArrayBuffer;
  fileName: string;
}

export interface CompressPDFDialogProps {
  documentKey: unknown;
  revision: number;
  currentPage: number;
  readPDF: (signal: AbortSignal) => Promise<CompressPDFSource>;
  onClose: () => void;
}
