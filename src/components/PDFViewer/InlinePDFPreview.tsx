import { useLocale } from "../../i18n";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';
import { TextLayer } from './TextLayer';

export function InlinePDFPreview({ png, bytes, pageNumber, scale, rotation, editing }: { png: Uint8Array<ArrayBuffer>; bytes: Uint8Array<ArrayBuffer>; pageNumber: number; scale: number; rotation: number; editing: boolean }) {
  useLocale();
  const image = useRef<HTMLImageElement>(null);
  const key = useMemo(() => ({ bytes, pageNumber }), [bytes, pageNumber]);
  const request = useRef<{ key: typeof key; task: PDFDocumentLoadingTask } | null>(null);
  const [loaded, setLoaded] = useState<{ key: typeof key; page: PDFPageProxy } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    if (image.current) image.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [png]);
  useEffect(() => {
    // Typing only hides selection. Keep its owner alive until different preview
    // bytes are ready, so quickly pressing Done cannot revive a disposed page.
    if (editing || request.current?.key === key) return;
    void request.current?.task.destroy().catch(() => {});
    const current = { key, task: pdfjsLib.getDocument({ ...pdfDocumentOptions, data: key.bytes.slice() }) };
    request.current = current;
    void current.task.promise.then(async document => {
      if (request.current !== current) return;
      const page = await document.getPage(key.pageNumber);
      if (request.current === current) setLoaded({ key, page });
    }).catch(() => {});
  }, [key, editing]);
  useEffect(() => () => {
    const current = request.current; request.current = null;
    void current?.task.destroy().catch(() => {});
  }, []);
  return <>
    <img ref={image} className="text-edit-preview" alt="" draggable={false} />
    {!editing && loaded?.key === key && <div className="text-edit-preview-selection"><TextLayer page={loaded.page} scale={scale} rotation={rotation} /></div>}
  </>;
}
