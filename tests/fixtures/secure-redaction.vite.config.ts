import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import viteConfig from '../../vite.config';

// Exercise the same Vite configuration as the app through an independent entry.
export default mergeConfig(viteConfig, defineConfig({
  base: './',
  build: {
    outDir: 'node_modules/.cache/secure-redaction-fixture',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./secure-redaction.html', import.meta.url)),
      output: { manualChunks: () => undefined },
    },
  },
}));
