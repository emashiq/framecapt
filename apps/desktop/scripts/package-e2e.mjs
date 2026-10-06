// Builds the app for the E2E suite: `electron-forge package` with FRAMECAPT_E2E_BUILD=1, which
// compiles in the mock capture provider and the synthetic frame generator (both are removed from
// every normal build; see scripts/check-no-mocks.mjs). Cross-platform replacement for
// `FRAMECAPT_E2E_BUILD=1 electron-forge package`, which cmd.exe cannot run.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The dependency is hoisted to the workspace root: resolve it instead of assuming apps/desktop/node_modules.
const forge = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@electron-forge/cli/package.json')),
  'dist',
  'electron-forge.js',
);

const result = spawnSync(process.execPath, [forge, 'package'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, FRAMECAPT_E2E_BUILD: '1' },
});
process.exit(result.status ?? 1);
