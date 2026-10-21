import { defineConfig } from 'vitest/config';

export default defineConfig({
  // @muzradar/shared берётся из исходников; остальные условия — дефолтные для Vite SSR.
  ssr: { resolve: { conditions: ['@muzradar/source', 'module', 'node', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // PGlite с PostGIS стартует ~10–25 с: БД-тесты идут последовательно в одном воркере.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
