import { defineConfig } from '@playwright/test';

// A hosted runner (1 physical core, no GPU, software VP8) runs the recording flows about 4x slower
// than a development PC: give it room, never less than the local limits.
const slowRunner = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  // A hosted runner's timing varies from VM to VM: a failed test gets two more tries there (the
  // trace of each is kept). Never locally.
  retries: slowRunner ? 2 : 0,
  timeout: slowRunner ? 120_000 : 60_000,
  expect: { timeout: slowRunner ? 15_000 : 5_000 },
  reporter: 'list',
  outputDir: 'test-results',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
  },
});
