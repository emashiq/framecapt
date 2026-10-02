import { defineConfig } from '@playwright/test';

/** Native verification on a real interactive host: `npm run test:native`. Not part of test:e2e. */
export default defineConfig({
  testDir: './tests/native',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
});
