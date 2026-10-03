import { defineConfig } from '@playwright/test';

/** Native verification on a real interactive host: `npm run test:native`. Not part of test:e2e. */
export default defineConfig({
  testDir: './tests/native',
  // The Linux build has its own config (playwright.linux.config.ts).
  testIgnore: /linux.native.spec.ts/,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  outputDir: 'test-results',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
  },
});
