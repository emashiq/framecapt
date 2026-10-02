import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { SettingsStore, SETTINGS_FILE } from '../../src/main/settings/store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-settings-'));
  file = path.join(dir, SETTINGS_FILE);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = (): { version: number; general: { theme: string }; recording: { fps: number } } =>
  JSON.parse(fs.readFileSync(file, 'utf8'));
const asideFiles = (): string[] =>
  fs.readdirSync(dir).filter((name) => name.startsWith(`${SETTINGS_FILE}.corrupt-`));

describe('loading', () => {
  it('no file: the defaults, and nothing is written yet', async () => {
    const store = new SettingsStore(file);
    expect(await store.load()).toEqual({ existed: false, reset: false });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.consumeResetNotice()).toBe(false);
  });

  it('reads a valid file', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, general: { theme: 'dark' }, recording: { fps: 60 } }),
    );
    const store = new SettingsStore(file);
    expect(await store.load()).toEqual({ existed: true, reset: false });
    expect(store.get().general.theme).toBe('dark');
    expect(store.get().recording.fps).toBe(60);
    expect(store.get().general.closeToTray).toBe(true);
    expect(store.hasPendingWrite).toBe(false);
  });

  it('a damaged file is set aside, the defaults are used, and the notice comes once', async () => {
    fs.writeFileSync(file, '{ this is not json');
    const store = new SettingsStore(file, { now: () => 1234 });
    expect(await store.load()).toEqual({ existed: true, reset: true });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(dir, `${SETTINGS_FILE}.corrupt-1234`), 'utf8')).toBe(
      '{ this is not json',
    );
    expect(store.consumeResetNotice()).toBe(true);
    expect(store.consumeResetNotice()).toBe(false);
  });

  it('a file that parses but is invalid is set aside too', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, general: { theme: 'neon' } }));
    const store = new SettingsStore(file);
    expect((await store.load()).reset).toBe(true);
    expect(asideFiles()).toHaveLength(1);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('a file from a newer app is set aside, not overwritten', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 7, general: { theme: 'dark' } }));
    const store = new SettingsStore(file);
    expect((await store.load()).reset).toBe(true);
    expect(asideFiles()).toHaveLength(1);
  });

  it('migrates an unversioned file and writes the new shape', async () => {
    fs.writeFileSync(file, JSON.stringify({ theme: 'light', fps: 60 }));
    const store = new SettingsStore(file, { debounceMs: 5 });
    expect(await store.load()).toEqual({ existed: true, reset: false });
    expect(store.get().general.theme).toBe('light');
    expect(store.hasPendingWrite).toBe(true);
    await store.flush();
    expect(readJson().version).toBe(1);
    expect(readJson().general.theme).toBe('light');
  });
});

describe('writing', () => {
  it('writes atomically: a temp file in the same folder, then a rename, nothing left behind', async () => {
    const calls: { file: string; bytes: number }[] = [];
    const store = new SettingsStore(file, {
      write: async (target, data) => {
        calls.push({ file: target, bytes: data.length });
        const { writeFileAtomic } = await import('../../src/main/shots/atomic-write');
        await writeFileAtomic(target, data);
      },
    });
    await store.load();
    store.update({ general: { theme: 'dark' } });
    await store.flush();
    expect(calls).toHaveLength(1);
    expect(readJson().general.theme).toBe('dark');
    expect(fs.readdirSync(dir)).toEqual([SETTINGS_FILE]);
  });

  it('debounces: a burst of changes within 300 ms is one write', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const store = new SettingsStore(file, {
      write: async (_target, data) => {
        writes.push(Buffer.from(data).toString('utf8'));
      },
    });
    await store.load();
    store.update({ recording: { fps: 60 } });
    await vi.advanceTimersByTimeAsync(200);
    store.update({ general: { theme: 'light' } });
    await vi.advanceTimersByTimeAsync(299);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    await store.flush(); // the timer started the write; wait for its (real) file I/O
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? '{}')).toMatchObject({
      version: 1,
      general: { theme: 'light' },
      recording: { fps: 60 },
    });
    // Nothing changed since: no second write.
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
  });

  it('a change that does not change anything writes nothing and notifies nobody', async () => {
    const store = new SettingsStore(file);
    await store.load();
    const listener = vi.fn();
    store.onChange(listener);
    store.update({ general: { theme: 'system' } });
    expect(listener).not.toHaveBeenCalled();
    expect(store.hasPendingWrite).toBe(false);
  });

  it('flush writes immediately and survives a failing write', async () => {
    let fail = true;
    const store = new SettingsStore(file, {
      write: async (target, data) => {
        if (fail) throw new Error('disk gone');
        fs.writeFileSync(target, data);
      },
    });
    await store.load();
    store.update({ general: { theme: 'dark' } });
    await store.flush(); // fails quietly
    expect(store.hasPendingWrite).toBe(true);
    fail = false;
    await store.flush();
    expect(readJson().general.theme).toBe('dark');
  });
});

describe('changes', () => {
  it('rejects an invalid shortcut set and keeps the old value', async () => {
    const store = new SettingsStore(file);
    await store.load();
    expect(() => store.update({ shortcuts: { stopRecording: 'Ctrl+Shift+1' } })).toThrow(
      /already used/,
    );
    expect(() => store.update({ shortcuts: { stopRecording: 'A' } })).toThrow(/Ctrl or Alt/);
    expect(store.get().shortcuts.stopRecording).toBe('Ctrl+Shift+0');
  });

  it('stores accelerators in canonical form and lets one be disabled', async () => {
    const store = new SettingsStore(file);
    await store.load();
    store.update({ shortcuts: { recordScreen: 'alt+control+q', recordWindow: null } });
    expect(store.get().shortcuts.recordScreen).toBe('Ctrl+Alt+Q');
    expect(store.get().shortcuts.recordWindow).toBeNull();
  });

  it('notifies listeners with the new settings, and reset restores a section', async () => {
    const store = new SettingsStore(file);
    await store.load();
    const seen: string[] = [];
    store.onChange((settings) => seen.push(settings.general.theme));
    store.update({ general: { theme: 'dark' } });
    store.reset('general');
    expect(seen).toEqual(['dark', 'system']);
  });

  it('output folders are set through setOutputDir and survive a reload', async () => {
    const store = new SettingsStore(file, { debounceMs: 1 });
    await store.load();
    store.setOutputDir('recording', 'D:\\Clips');
    store.setOutputDir('screenshots', 'D:\\Shots');
    await store.flush();
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().recording.outputDir).toBe('D:\\Clips');
    expect(again.get().screenshots.outputDir).toBe('D:\\Shots');
    again.setOutputDir('recording', null);
    expect(again.get().recording.outputDir).toBeNull();
  });

  it('remembers the tray hint once', async () => {
    const store = new SettingsStore(file);
    await store.load();
    const listener = vi.fn();
    store.onChange(listener);
    store.markTrayHintShown();
    store.markTrayHintShown();
    expect(store.get().notices.trayHintShown).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
