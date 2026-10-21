import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 20_000,
    // Tests spawn processes and bind ports; run files in separate forks.
    pool: 'forks',
  },
});
