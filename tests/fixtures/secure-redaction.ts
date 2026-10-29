import { PDFDocument } from 'pdf-lib';
import { applySecureRedactions } from '../../src/editing/SecureRedaction';
import { loadMuPDF } from '../../src/utils/mupdf';

const result = document.querySelector<HTMLOutputElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
result.textContent = 'Ready; engine not loaded';

button.addEventListener('click', () => {
  button.disabled = true;
  void (async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([300, 400]);
    page.drawText('PRIVATE_398172', { x: 20, y: 300, size: 14 });
    page.drawText('PUBLIC_REMAINS', { x: 20, y: 100, size: 14 });
    const bytes = await applySecureRedactions(new Uint8Array(await source.save()).buffer, [{
      id: 'fixture-area', pageNumber: 1, applied: false, overlayColor: '#000000',
      rect: { x: 10, y: 70, width: 200, height: 60 },
    }]);
    const engine = await loadMuPDF();
    const output = new engine.PDFDocument(bytes);
    try {
      const outputPage = output.loadPage(0);
      try {
        const text = outputPage.toStructuredText('');
        try {
          const extracted = text.asText();
          if (extracted.includes('PRIVATE_398172') || !extracted.includes('PUBLIC_REMAINS')) {
            throw new Error('Content-removal verification failed');
          }
          result.textContent = `PASS: ${extracted.trim()}; ${bytes.byteLength} bytes`;
        } finally { text.destroy(); }
      } finally { outputPage.destroy(); }
    } finally { output.destroy(); }
  })().catch(error => { result.textContent = `ERROR: ${String(error)}`; });
});
