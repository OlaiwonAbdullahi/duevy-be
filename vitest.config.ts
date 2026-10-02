import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Database-backed tests run separately: npm run test:int
    exclude: ['src/**/*.int.test.ts', 'node_modules/**'],
    // src/config/env.ts parses process.env at import time and calls
    // process.exit(1) on a miss, so the fake values have to be in place before
    // any module under test is loaded.
    setupFiles: ['src/test/setup.ts'],
  },
});
