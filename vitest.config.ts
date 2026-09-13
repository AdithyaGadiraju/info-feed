import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Live-endpoint smoke tests are the point (ADR 0002): give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Source tests hit third-party endpoints; running files sequentially keeps us polite.
    fileParallelism: false,
    env: { TZ: 'Australia/Sydney' },
  },
});
