import { defineConfig } from 'vitest/config';

// Standalone config for the RAG subsystem (the root vitest config only includes
// src/**). These tests need no DB and no API key — pure chunking + lexical search.
// Run:  npx vitest run --config ai-engineering/rag/vitest.config.ts
export default defineConfig({
  test: {
    include: ['ai-engineering/rag/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
