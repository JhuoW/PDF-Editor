import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './build/pdfjsAssets'
import { ocrAssets } from './build/ocrAssets'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const revision = (() => { try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' } })()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsAssets(), ocrAssets()],
  define: { __APP_VERSION__: JSON.stringify(`${version} (${revision})`) },
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['pdfjs-dist'],
    // Preserve MuPDF's import.meta.url-relative WASM asset during development.
    exclude: ['mupdf'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          'pdf-lib': ['pdf-lib'],
        },
      },
    },
  },
})
