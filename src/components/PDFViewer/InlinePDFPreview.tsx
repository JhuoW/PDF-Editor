import { useLocale } from "../../i18n";
import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';
import { TextLayer } from './TextLayer';

export function InlinePDFPreview({ png, bytes, pageNumber, scale, rotation, editing }: { png: Uint8Array<ArrayBuffer>; bytes: Uint8Array<ArrayBuffer>; pageNumber: number; scale: number; rotation: number; editing: boolean }) {
  useLocale();
  const image = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState<{ bytes: Uint8Array; page: PDFPageProxy } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    if (image.current) image.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [png]);
  useEffect(() => {
    if (editing) return;
    let canceled = false;
    const task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: bytes.slice() });
    void task.promise.then(document => document.getPage(pageNumber)).then(page => { if (!canceled) setLoaded({ bytes, page }); }).catch(() => {});
    return () => { canceled = true; void task.destroy().catch(() => {}); };
  }, [bytes, pageNumber, editing]);
  return <>
    <img ref={image} className="text-edit-preview" alt="" draggable={false} />
    {!editing && loaded?.bytes === bytes && <div className="text-edit-preview-selection"><TextLayer page={loaded.page} scale={scale} rotation={rotation} /></div>}
  </>;
}
