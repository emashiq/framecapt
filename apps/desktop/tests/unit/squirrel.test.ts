import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    'FrameCapt',
    'app-0.1.0',
    'FrameCapt.exe',
  );
  const updateExe = path.resolve(path.dirname(squirrelExe), '..', 'Update.exe');

  it('matches the Squirrel shortcut id in a Squirrel install (Update.exe one level up)', () => {
    expect(appUserModelId(squirrelExe, (file) => file === updateExe)).toBe(
      'com.squirrel.FrameCapt.FrameCapt',
    );
  });

  it('is the provisional app id for the portable zip and unpackaged runs', () => {
    expect(appUserModelId(squirrelExe, () => false)).toBe('com.framecapt.app');
  });
});

describe('handleSquirrelEvent', () => {
  // The uninstall flow reads its environment after the hook returns, so it is restored per test.
  let baseEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    baseEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = baseEnv;
  });

  interface Setup {
    env?: Record<string, string>;
    userData?: string;
    pictures?: string;
    videos?: string;
    answer?: { response: number; checkboxChecked: boolean };
  }

  async function run(argv1: string | undefined, setup: Setup = {}) {
    vi.resetModules();
    const quit = vi.fn();
    const exit = vi.fn();
    const paths: Record<string, string> = {
      userData: setup.userData ?? path.join(os.tmpdir(), 'framecapt-test-missing-userdata'),
      pictures: setup.pictures ?? path.join(os.tmpdir(), 'framecapt-test-missing-pictures'),
      videos: setup.videos ?? path.join(os.tmpdir(), 'framecapt-test-missing-videos'),
    };
    const setPath = vi.fn();
    // Update.exe "ends" right after it starts.
    const spawn = vi.fn(() => ({
      on: (event: string, callback: () => void) => {
        if (event === 'close') setTimeout(callback, 0);
      },
    }));
    const setLoginItemSettings = vi.fn();
    const showMessageBox = vi.fn(() =>
      Promise.resolve(setup.answer ?? { response: 0, checkboxChecked: false }),
    );
    const trashItem = vi.fn((_target: string) => Promise.resolve());
    vi.doMock('electron', () => ({
      app: {
        quit,
        exit,
        setLoginItemSettings,
        setPath,
        getPath: (name: string) => paths[name],
        whenReady: () => Promise.resolve(),
      },
      dialog: { showMessageBox },
      shell: { trashItem },
    }));
    vi.doMock('node:child_process', () => ({ spawn }));
    const original = process.argv;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.assign(process.env, setup.env);
    process.argv = ['FrameCapt.exe', ...(argv1 ? [argv1] : [])];
    // The hooks are Windows-only: their logic is exercised as win32 on every OS.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { handleSquirrelEvent } = await import('../../src/main/squirrel');
      return {
        handled: handleSquirrelEvent(),
        quit,
        exit,
        spawn,
        setLoginItemSettings,
        setPath,
        showMessageBox,
        trashItem,
      };
    } finally {
      process.argv = original;
      if (platform) Object.defineProperty(process, 'platform', platform);
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
      await vi.waitFor(() => expect(result.quit).toHaveBeenCalled());
    }
  });

  it('quits at once on --squirrel-obsolete', async () => {
    const result = await run('--squirrel-obsolete');
    expect(result.handled).toBe(true);
    expect(result.quit).toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  describe('uninstall', () => {
    let root: string;
    let userData: string;
    let pictures: string;
    let videos: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-squirrel-'));
      userData = path.join(root, 'AppData', 'FrameCapt');
      pictures = path.join(root, 'Pictures');
      videos = path.join(root, 'Videos');
      fs.mkdirSync(path.join(userData, 'history'), { recursive: true });
      fs.mkdirSync(path.join(pictures, 'FrameCapt'), { recursive: true });
      fs.mkdirSync(path.join(videos, 'FrameCapt'), { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const start = (setup: Setup = {}) =>
      run('--squirrel-uninstall', { userData, pictures, videos, ...setup });
    const finished = (result: Awaited<ReturnType<typeof run>>) =>
      vi.waitFor(() => expect(result.quit).toHaveBeenCalled());

    it('removes shortcuts and the launch-at-login entry, moves Chromium off the real data folder', async () => {
      const result = await start({ env: { FRAMECAPT_UNINSTALL_KEEP: '1' } });
      expect(result.handled).toBe(true);
      await finished(result);
      expect(result.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
      const [, args, options] = result.spawn.mock.calls[0] as unknown as [string, string[], object];
      expect(args).toEqual(['--removeShortcut', path.basename(process.execPath)]);
      expect(options).toMatchObject({ shell: false });
      const redirected = result.setPath.mock.calls as Array<[string, string]>;
      expect(redirected.map(([name]) => name)).toEqual(['userData', 'sessionData', 'crashDumps']);
      for (const [, target] of redirected) {
        expect(target).toContain(`framecapt-uninstall-${process.pid}`);
        expect(target.startsWith(os.tmpdir())).toBe(true);
      }
    });

    it('keeps everything without a question when FRAMECAPT_UNINSTALL_KEEP=1', async () => {
      const result = await start({ env: { FRAMECAPT_UNINSTALL_KEEP: '1' } });
      await finished(result);
      expect(result.showMessageBox).not.toHaveBeenCalled();
      expect(fs.existsSync(userData)).toBe(true);
    });

    it('asks Keep / Remove with a timeout and an unchecked Recycle Bin box, and keeps by default', async () => {
      const result = await start();
      await finished(result);
      expect(result.showMessageBox).toHaveBeenCalledTimes(1);
      const [options] = result.showMessageBox.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(options).toMatchObject({
        buttons: ['Keep my data', 'Remove'],
        defaultId: 0,
        cancelId: 0,
        checkboxChecked: false,
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(fs.existsSync(userData)).toBe(true);
      expect(result.trashItem).not.toHaveBeenCalled();
    });

    it('asks nothing when there is no data folder', async () => {
      fs.rmSync(userData, { recursive: true });
      const result = await start();
      await finished(result);
      expect(result.showMessageBox).not.toHaveBeenCalled();
    });

    it('asks nothing while FrameCapt runs (its lockfile cannot be deleted)', async () => {
      // A folder named lockfile stands in for the open file: rmSync without recursive refuses it.
      fs.mkdirSync(path.join(userData, 'lockfile'));
      const result = await start();
      await finished(result);
      expect(result.showMessageBox).not.toHaveBeenCalled();
      expect(fs.existsSync(userData)).toBe(true);
    });

    it('Remove deletes the app data and leaves the captures alone', async () => {
      const shot = path.join(pictures, 'FrameCapt', 'FrameCapt 2026-10-02 at 14.05.09.png');
      fs.writeFileSync(shot, 'x');
      const result = await start({ answer: { response: 1, checkboxChecked: false } });
      await finished(result);
      expect(fs.existsSync(userData)).toBe(false);
      expect(fs.existsSync(shot)).toBe(true);
      expect(result.trashItem).not.toHaveBeenCalled();
    });

    it('Remove with the box moves a default folder of FrameCapt files, and listed files elsewhere, to the Recycle Bin', async () => {
      fs.writeFileSync(
        path.join(pictures, 'FrameCapt', 'FrameCapt 2026-10-02 at 14.05.09.png'),
        'x',
      );
      // The videos folder also holds a file of the user's: only history's files go from it.
      const recording = path.join(videos, 'FrameCapt', 'FrameCapt 2026-10-02 at 14.05.10.webm');
      fs.writeFileSync(recording, 'x');
      fs.writeFileSync(path.join(videos, 'FrameCapt', 'notes.txt'), 'mine');
      fs.writeFileSync(
        path.join(userData, 'history', 'history.json'),
        JSON.stringify({ version: 1, items: [{ path: recording }, { path: 'relative.png' }] }),
      );
      const result = await start({ answer: { response: 1, checkboxChecked: true } });
      await finished(result);
      expect(fs.existsSync(userData)).toBe(false);
      expect(result.trashItem.mock.calls.map(([target]) => target)).toEqual([
        path.join(pictures, 'FrameCapt'),
        recording,
      ]);
    });
  });
});
