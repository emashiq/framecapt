// Runs the Playwright e2e suite: `node scripts/run-e2e.mjs [playwright test arguments]`.
//
// On Windows the Playwright worker (a Node 24 process) occasionally dies with 0xC0000409 while it is
// in `electron.launch()`; no test or app code is involved (see "Known flake" in docs/testing.md).
// Playwright reports that test as failed after 0 ms. When EVERY failure of a run is such a worker
// death, only those tests are run once more (`--last-failed`); any other failure, or a second
// crash, fails the run as before.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const WORKER_CRASH = /worker process exited unexpectedly \(code=3221226505/;
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const extra = process.argv.slice(2);

function playwright(args, jsonFile) {
  const env = { ...process.env };
  if (jsonFile) env.PLAYWRIGHT_JSON_OUTPUT_NAME = jsonFile;
  return spawnSync(process.execPath, [cli, 'test', ...args], { stdio: 'inherit', env }).status ?? 1;
}

function failures(report) {
  const out = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'unexpected') out.push(test);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return out;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-report-'));
const jsonFile = path.join(dir, 'report.json');
let status;
try {
  status = playwright(['--reporter=list,json', ...extra], jsonFile);
  if (status !== 0 && fs.existsSync(jsonFile)) {
    const failed = failures(JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
    const crashed = (test) =>
      test.results.every((result) =>
        (result.errors ?? [result.error]).some((error) => WORKER_CRASH.test(error?.message ?? '')),
      );
    if (failed.length > 0 && failed.every(crashed)) {
      console.warn(
        `\n${failed.length} test(s) failed only because the Playwright worker process died; running them once more.\n`,
      );
      status = playwright(['--last-failed', ...extra]);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
