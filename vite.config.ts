import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './build/pdfjsAssets'
import { ocrAssets } from './build/ocrAssets'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsAssets(), ocrAssets()],
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
