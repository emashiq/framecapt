import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { HIDDEN_ARG, loginItemOptions } from '../../src/main/settings/login-item';
import { probeWritable, resolveOutputDirs } from '../../src/main/settings/output-dirs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-dirs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveOutputDirs', () => {
  it('defaults to Pictures/FrameCapt and Videos/FrameCapt', () => {
    expect(resolveOutputDirs(DEFAULT_SETTINGS, { pictures: 'P', videos: 'V' })).toEqual({
      screenshotsDir: path.join('P', 'FrameCapt'),
      recordingsDir: path.join('V', 'FrameCapt'),
    });
  });

  it('uses a chosen folder', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.recording.outputDir = 'D:\\Clips';
    expect(resolveOutputDirs(settings, { pictures: 'P', videos: 'V' }).recordingsDir).toBe(
      'D:\\Clips',
    );
  });
});

describe('probeWritable', () => {
  it('accepts a writable folder, makes a missing one, and leaves no probe file behind', async () => {
    expect(await probeWritable(dir)).toBe(true);
    const nested = path.join(dir, 'a', 'b');
    expect(await probeWritable(nested)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.framecapt-probe'))).toEqual([]);
    expect(fs.readdirSync(nested)).toEqual([]);
  });

  it('refuses a folder that cannot be created or written (a file is in the way)', async () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(await probeWritable(path.join(file, 'sub'))).toBe(false);
    expect(await probeWritable(file)).toBe(false);
  });

  it('refuses a relative path', async () => {
    expect(await probeWritable('relative\\folder')).toBe(false);
  });
});

describe('loginItemOptions', () => {
  it('off is just off', () => {
    expect(loginItemOptions(false, { execPath: 'C:\\App\\FrameCapt.exe' })).toEqual({
      openAtLogin: false,
    });
  });

  it('a plain install registers the exe itself, starting hidden', () => {
    expect(
      loginItemOptions(true, { execPath: 'C:\\App\\FrameCapt.exe', exists: () => false }),
    ).toEqual({ openAtLogin: true, path: 'C:\\App\\FrameCapt.exe', args: [HIDDEN_ARG] });
  });

  it('a Squirrel install goes through Update.exe so updates keep working', () => {
    const exec = path.join('C:\\Users\\me\\AppData\\Local\\framecapt\\app-1.0.0', 'FrameCapt.exe');
    const update = path.resolve(path.dirname(exec), '..', 'Update.exe');
    const options = loginItemOptions(true, { execPath: exec, exists: (file) => file === update });
    expect(options).toEqual({
      openAtLogin: true,
      path: update,
      args: ['--processStart', 'FrameCapt.exe', '--process-start-args', HIDDEN_ARG],
    });
  });
});
