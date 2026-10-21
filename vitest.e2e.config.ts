import { defineConfig } from 'vitest/config';

// End-to-end tests run the built CLI (dist/) against a real Cloudflare quick tunnel.
// They are skipped automatically when cloudflared is not installed.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
