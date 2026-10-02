import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '..', '..', 'scripts', 'check-no-mocks.mjs');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-nomock-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, text: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A clean build: the three bundles a packaged app is made of. */
function cleanBuild(): void {
  write('.vite/build/main.cjs', 'const a = 1;');
  write('.vite/build/preload.cjs', 'const b = 2;');
  write('.vite/renderer/main_window/assets/index.js', 'const c = 3;');
}

function check(...args: string[]) {
  const result = spawnSync(process.execPath, [script, '--root', root, ...args], {
    shell: false,
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('check-no-mocks', () => {
  it('passes a clean build and says what it scanned', () => {
    cleanBuild();
    const result = check();
    expect(result.code).toBe(0);
    expect(result.out).toContain('no mock or test-hook markers');
  });

  it('fails on the mock provider, any E2E env switch, and the synthetic renderer code', () => {
    for (const [file, text] of [
      ['.vite/build/main.cjs', 'class MockCaptureProvider {}'],
      ['.vite/build/main.cjs', 'process.env.FRAMELET_E2E_SOMETHING_NEW'],
      ['.vite/build/preload.cjs', 'globalThis.__frameletTest = {}'],
      ['.vite/renderer/main_window/assets/index.js', 'function drawSyntheticFrame(){}'],
    ] as const) {
      cleanBuild();
      write(file, text);
      const result = check();
      expect(result.code, `${file}: ${text}`).toBe(1);
      expect(result.out).toContain('FAIL');
    }
  });

  it('also scans the packaged app.asar that ships', () => {
    cleanBuild();
    write(
      'out/Framelet-win32-x64/resources/app.asar',
      '{"files":{}}\u0000...MockCaptureProvider...',
    );
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('app.asar');
  });

  it('refuses to pass when the bundles are not there at all', () => {
    expect(check().code).toBe(2);
    write('.vite/build/main.cjs', 'x');
    expect(check().code, 'a missing preload bundle is an error, not a pass').toBe(2);
  });

  it('--expect-mock is the positive control: it needs the mock in main AND the renderer', () => {
    cleanBuild();
    expect(check('--expect-mock').code).toBe(1);
    write('.vite/build/main.cjs', 'MockCaptureProvider');
    expect(check('--expect-mock').code).toBe(1);
    write('.vite/renderer/main_window/assets/index.js', 'drawSyntheticFrame');
    expect(check('--expect-mock').code).toBe(0);
  });
});
