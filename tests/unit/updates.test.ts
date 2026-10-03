import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isValidFeedUrl, UpdateService, type AutoUpdaterLike } from '../../src/main/updates';

function fakeUpdater() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const updater = {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      handlers.set(event, listener);
      return updater;
    }),
  };
  return { updater: updater as unknown as AutoUpdaterLike & typeof updater, handlers };
}

describe('UpdateService: unconfigured (the default for every build)', () => {
  for (const feedUrl of ['', '   ']) {
    it(`reports "unconfigured" and never touches autoUpdater (feed ${JSON.stringify(feedUrl)})`, () => {
      const { updater } = fakeUpdater();
      const getAutoUpdater = vi.fn(() => updater);
      const service = new UpdateService({ feedUrl, getAutoUpdater, isSquirrelInstall: () => true });
      expect(service.getStatus()).toEqual({ state: 'unconfigured' });
      service.checkNow();
      service.installAndRestart();
      expect(service.getStatus()).toEqual({ state: 'unconfigured' });
      // No autoUpdater was even loaded: no feed URL set, no check, no network.
      expect(getAutoUpdater).not.toHaveBeenCalled();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });
  }

  it('constructing a configured service alone makes no autoUpdater call either', () => {
    const { updater } = fakeUpdater();
    const getAutoUpdater = vi.fn(() => updater);
    const service = new UpdateService({
      feedUrl: 'https://updates.example.com/framecapt',
      getAutoUpdater,
      isSquirrelInstall: () => true,
    });
    expect(service.getStatus()).toEqual({ state: 'idle' });
    expect(getAutoUpdater).not.toHaveBeenCalled();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });
});

describe('UpdateService: configured (future)', () => {
  const feedUrl = 'https://updates.example.com/framecapt/win32/x64';
  function configured(isSquirrelInstall = true) {
    const fake = fakeUpdater();
    const service = new UpdateService({
      feedUrl,
      getAutoUpdater: () => fake.updater,
      isSquirrelInstall: () => isSquirrelInstall,
    });
    const seen: string[] = [];
    service.onChange((status) => seen.push(status.state));
    return { ...fake, service, seen };
  }

  it('walks checking -> available -> downloading -> ready and can install', () => {
    const { service, updater, handlers, seen } = configured();
    service.checkNow();
    expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({ url: feedUrl });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.getStatus().state).toBe('checking');
    handlers.get('update-available')?.();
    handlers.get('update-downloaded')?.();
    expect(service.getStatus().state).toBe('ready');
    expect(seen).toEqual(['checking', 'available', 'downloading', 'ready']);
    service.installAndRestart();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('returns to idle when there is no update, and sets the feed only once', () => {
    const { service, updater, handlers } = configured();
    service.checkNow();
    handlers.get('update-not-available')?.();
    expect(service.getStatus().state).toBe('idle');
    service.checkNow();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('turns autoUpdater errors into the error state and allows a retry', () => {
    const { service, updater, handlers } = configured();
    service.checkNow();
    handlers.get('error')?.(new Error('offline') as never);
    expect(service.getStatus()).toEqual({ state: 'error', message: 'offline' });
    service.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not check twice at once and cannot install before an update is ready', () => {
    const { service, updater } = configured();
    service.checkNow();
    service.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    service.installAndRestart();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports an error instead of calling autoUpdater outside a Squirrel install', () => {
    const { service, updater } = configured(false);
    service.checkNow();
    expect(service.getStatus().state).toBe('error');
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('refuses a non-https feed', () => {
    const { updater } = fakeUpdater();
    const getAutoUpdater = vi.fn(() => updater);
    const service = new UpdateService({
      feedUrl: 'http://updates.example.com/',
      getAutoUpdater,
      isSquirrelInstall: () => true,
    });
    expect(service.getStatus().state).toBe('error');
    service.checkNow();
    expect(getAutoUpdater).not.toHaveBeenCalled();
    expect(isValidFeedUrl('file:///C:/feed')).toBe(false);
    expect(isValidFeedUrl('https://u.example/x')).toBe(true);
  });
});

describe('update code is confined', () => {
  it('only updates.ts calls the autoUpdater API (index.ts just hands it over lazily)', () => {
    const dir = path.resolve(__dirname, '..', '..', 'src');
    const files = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const name = path.basename(file);
      if (name !== 'updates.ts') {
        expect(text, name).not.toMatch(/\.(setFeedURL|checkForUpdates|quitAndInstall)\s*\(/);
      }
      if (name !== 'index.ts' && name !== 'updates.ts')
        expect(text, name).not.toMatch(/autoUpdater/);
    }
  });
});
