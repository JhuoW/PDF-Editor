import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** OCR runs entirely in the browser, including self-hosted engines and models. */
export function ocrAssets(): Plugin {
  const root = dirname(fileURLToPath(import.meta.resolve('tesseract.js/package.json')));
  const core = dirname(fileURLToPath(import.meta.resolve('tesseract.js-core/package.json')));
  const assets = new Map<string, string>([
    ['ocr/worker.min.js', join(root, 'dist/worker.min.js')],
    ['ocr/worker.min.js.LICENSE.txt', join(root, 'dist/worker.min.js.LICENSE.txt')],
    ['licenses/tesseract.js-Apache-2.0.txt', join(root, 'LICENSE.md')],
    ['licenses/tesseract.js-core-Apache-2.0.txt', join(core, 'LICENSE')],
    // Model data license: https://github.com/naptha/tessdata/blob/gh-pages/LICENSE
    // The language npm packages omit this upstream data license from their tarballs.
    ['licenses/tessdata-Apache-2.0.txt', fileURLToPath(new URL('./licenses/tessdata-Apache-2.0.txt', import.meta.url))],
  ]);
  // Include every SIMD/relaxed-SIMD fallback supported by the installed engine.
  // Only the engine selected by the worker is downloaded by the browser.
  for (const file of readdirSync(core)) {
    if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(file)) assets.set(`ocr/core/${file}`, join(core, file));
  }
  for (const language of ['eng', 'chi_sim']) {
    const model = dirname(fileURLToPath(import.meta.resolve(`@tesseract.js-data/${language}/package.json`)));
    assets.set(`ocr/lang/${language}.traineddata.gz`, join(model, '4.0.0_best_int', `${language}.traineddata.gz`));
  }
  let base = '/';
  return {
    name: 'ocr-local-assets',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const prefix = base === './' || base === '' ? '/' : base;
        const key = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
        const source = assets.get(key);
        if (!source) { next(); return; }
        response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm'
          : key.endsWith('.js') ? 'text/javascript' : key.endsWith('.txt') ? 'text/plain' : 'application/octet-stream');
        // Traineddata is a gzip file, not a transparently encoded HTTP response.
        response.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
  };
}
