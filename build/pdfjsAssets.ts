import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Serve and package PDF.js fonts, CMaps and decoders from the installed version. */
export function pdfjsAssets(): Plugin {
  const root = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  const assets = new Map<string, string>();
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const file of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (file.isFile()) assets.set(`pdfjs/${directory}/${file.name}`, join(root, directory, file.name));
    }
  }
  assets.set('licenses/mupdf-AGPL-3.0.txt', fileURLToPath(new URL('../LICENSE', import.meta.resolve('mupdf'))));
  assets.set('licenses/pdfjs-Apache-2.0.txt', join(root, 'LICENSE'));
  assets.set('licenses/fflate-MIT.txt', join(dirname(fileURLToPath(import.meta.resolve('fflate/package.json'))), 'LICENSE'));
  let base = '/';
  return {
    name: 'pdfjs-local-assets',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const prefix = base === './' || base === '' ? '/' : base;
        const key = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
        const source = assets.get(key);
        if (!source) { next(); return; }
        response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm' : key.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        response.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
  };
}
