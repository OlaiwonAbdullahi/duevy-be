import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real Postgres (embedded, see globalSetup), real
 * migrations, an in-memory double for the payment rail and Didit. Files run one at a time
 * against the shared database; each test builds its own fixtures.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['src/test/integration/globalSetup.ts'],
    setupFiles: ['src/test/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
