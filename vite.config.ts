import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        play: resolve(import.meta.dirname, 'play/index.html'),
      },
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000 },
});
