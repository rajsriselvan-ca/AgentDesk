import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/global-setup.ts'],
    include: ['src/**/*.test.ts'],
    // Tool tests share one seeded database, so parallel files would race on
    // the same rows. Sequential is the honest trade for a suite this size.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
