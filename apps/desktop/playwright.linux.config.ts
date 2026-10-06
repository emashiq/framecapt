import { defineConfig } from '@playwright/test';

/** Native verification of the experimental Linux build on a real X server: `npm run test:native:linux`. */
export default defineConfig({
  testDir: './tests/native',
  testMatch: /linux\.native\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
});
