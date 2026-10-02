// Builds the app for the E2E suite: `electron-forge package` with FRAMELET_E2E_BUILD=1, which
// compiles in the mock capture provider and the synthetic frame generator (both are removed from
// every normal build; see scripts/check-no-mocks.mjs). Cross-platform replacement for
// `FRAMELET_E2E_BUILD=1 electron-forge package`, which cmd.exe cannot run.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forge = path.join(
  root,
  'node_modules',
  '@electron-forge',
  'cli',
  'dist',
  'electron-forge.js',
);

const result = spawnSync(process.execPath, [forge, 'package'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, FRAMELET_E2E_BUILD: '1' },
});
process.exit(result.status ?? 1);
