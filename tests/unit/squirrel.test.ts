import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { quit: () => undefined, setLoginItemSettings: () => undefined },
}));

import { appUserModelId } from '../../src/main/squirrel';

describe('appUserModelId', () => {
  const squirrelExe = path.join(
    'C:',
    'Users',
    'u',
    'AppData',
    'Local',
    'Framelet',
    'app-0.1.0',
    'Framelet.exe',
  );
  const updateExe = path.resolve(path.dirname(squirrelExe), '..', 'Update.exe');

  it('matches the Squirrel shortcut id in a Squirrel install (Update.exe one level up)', () => {
    expect(appUserModelId(squirrelExe, (file) => file === updateExe)).toBe(
      'com.squirrel.Framelet.Framelet',
    );
  });

  it('is the provisional app id for the portable zip and unpackaged runs', () => {
    expect(appUserModelId(squirrelExe, () => false)).toBe('com.framelet.app');
  });
});

describe('handleSquirrelEvent', () => {
  async function run(argv1: string | undefined) {
    vi.resetModules();
    const quit = vi.fn();
    const spawn = vi.fn(() => ({ on: vi.fn() }));
    const setLoginItemSettings = vi.fn();
    vi.doMock('electron', () => ({
      app: { quit, setLoginItemSettings, whenReady: () => Promise.resolve() },
    }));
    vi.doMock('node:child_process', () => ({ spawn }));
    const original = process.argv;
    process.argv = ['Framelet.exe', ...(argv1 ? [argv1] : [])];
    try {
      const { handleSquirrelEvent } = await import('../../src/main/squirrel');
      return { handled: handleSquirrelEvent(), quit, spawn, setLoginItemSettings };
    } finally {
      process.argv = original;
    }
  }

  it('starts normally for an ordinary launch and for the first run after install', async () => {
    expect((await run(undefined)).handled).toBe(false);
    expect((await run('--hidden')).handled).toBe(false);
    const first = await run('--squirrel-firstrun');
    expect(first.handled).toBe(false);
    expect(first.quit).not.toHaveBeenCalled();
    expect(first.spawn).not.toHaveBeenCalled();
  });

  it('creates shortcuts on install and update, then quits without starting the UI', async () => {
    for (const event of ['--squirrel-install', '--squirrel-updated']) {
      const result = await run(event);
      expect(result.handled).toBe(true);
      expect(result.spawn).toHaveBeenCalledTimes(1);
      const [, args, options] = result.spawn.mock.calls[0] as unknown as [string, string[], object];
      expect(args).toEqual(['--createShortcut', path.basename(process.execPath)]);
      expect(options).toMatchObject({ shell: false });
    }
  });

  it('removes shortcuts and the launch-at-login entry on uninstall, and nothing else', async () => {
    const result = await run('--squirrel-uninstall');
    expect(result.handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // whenReady().then(...)
    expect(result.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    const [, args] = result.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(['--removeShortcut', path.basename(process.execPath)]);
  });

  it('quits at once on --squirrel-obsolete', async () => {
    const result = await run('--squirrel-obsolete');
    expect(result.handled).toBe(true);
    expect(result.quit).toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });
});
