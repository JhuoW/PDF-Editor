import { defineConfig, mergeConfig } from 'vitest/config';
import process from 'node:process';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // MuPDF/WASM rendering, font embedding and 300 dpi checks take several seconds
    // even when run alone, so local runs use the same limit as hosted runners.
    testTimeout: 30_000,
    // Limit simultaneous engines on CI so these correctness tests do not compete for CPU.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
}));
