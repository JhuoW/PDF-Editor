import { defineConfig, mergeConfig } from 'vitest/config';
import process from 'node:process';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // Font embedding and 300 dpi WASM rendering need more time on hosted runners.
    // Limit simultaneous engines so these correctness tests do not compete for CPU.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    maxWorkers: process.env.CI ? 2 : undefined,
  },
}));
