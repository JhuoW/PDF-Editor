import { useEffect, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { useDocumentStore } from '../../store/documentStore';

export function useNativePage(pageNumber: number) {
  const document = useDocumentStore(state => state.document);
  const [result, setResult] = useState<{ document: PDFDocumentProxy; page: PDFPageProxy } | null>(null);
  useEffect(() => {
    if (!document) return;
    let canceled = false;
    void document.getPage(pageNumber).then(page => { if (!canceled) setResult({ document, page }); }).catch(() => {});
    return () => { canceled = true; };
  }, [document, pageNumber]);
  return result?.document === document && result.page.pageNumber === pageNumber ? result.page : null;
}
