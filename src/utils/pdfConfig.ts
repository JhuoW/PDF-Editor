import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure PDF.js worker
// Resolve the worker from the installed version and the configured deployment base.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.document.baseURI).href;
export const pdfDocumentOptions = {
  cMapUrl: `${assets}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assets}standard_fonts/`,
  wasmUrl: `${assets}wasm/`,
  iccUrl: `${assets}iccs/`,
};

export { pdfjsLib };
