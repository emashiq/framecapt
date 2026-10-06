import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFfmpegResource } from '../../forge.config';
import {
  applyLinuxSwitches,
  autostartEntry,
  autostartPath,
  defaultMediaFolders,
  LINUX_OZONE_PLATFORM,
  quoteExecArg,
  setAutostart,
} from '../../src/main/linux';
import { windowIconFor } from '../../src/main/window-icon';
import { platformCapabilities } from '../../src/shared/platform';

describe('applyLinuxSwitches', () => {
  it('forces the X11 ozone platform and turns background networking off, on Linux only', () => {
    const calls: [string, string | undefined][] = [];
    const commandLine = {
      appendSwitch: (name: string, value?: string) => calls.push([name, value]),
    };
    applyLinuxSwitches(commandLine, 'win32');
    applyLinuxSwitches(commandLine, 'darwin');
    expect(calls).toEqual([]);
    applyLinuxSwitches(commandLine, 'linux');
    expect(calls).toEqual([
      ['ozone-platform', LINUX_OZONE_PLATFORM],
      ['disable-background-networking', undefined],
      ['disable-component-update', undefined],
    ]);
    expect(LINUX_OZONE_PLATFORM).toBe('x11');
  });
});

describe('platformCapabilities', () => {
  it('Windows has system audio and an excluded toolbar, with no notes', () => {
    expect(platformCapabilities('win32')).toEqual({
      systemAudio: true,
      toolbarExcludedFromCapture: true,
    });
  });

  it('Linux reports system audio unavailable up front, with the reason, and the toolbar note', () => {
    const linux = platformCapabilities('linux');
    expect(linux.systemAudio).toBe(false);
    expect(linux.systemAudioReason).toBe('Not available on Linux yet');
    expect(linux.toolbarExcludedFromCapture).toBe(false);
    expect(linux.toolbarNote).toContain('toolbar may appear');
  });
});

describe('defaultMediaFolders', () => {
  const home = path.resolve('/home/ada');

  it('uses what Electron resolves', () => {
    const dir = path.resolve('/data/xdg');
    expect(defaultMediaFolders((name) => path.join(dir, name), home)).toEqual({
      pictures: path.join(dir, 'pictures'),
      videos: path.join(dir, 'videos'),
    });
  });

  it('falls back to ~/Pictures and ~/Videos when the XDG directory is unset or unresolvable', () => {
    const throwing = (): string => {
      throw new Error("Failed to get 'pictures' path");
    };
    expect(defaultMediaFolders(throwing, home)).toEqual({
      pictures: path.join(home, 'Pictures'),
      videos: path.join(home, 'Videos'),
    });
    expect(defaultMediaFolders(() => '', home).videos).toBe(path.join(home, 'Videos'));
    expect(defaultMediaFolders(() => 'relative/dir', home).pictures).toBe(
      path.join(home, 'Pictures'),
    );
  });
});

describe('autostart', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-autostart-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('quotes an Exec argument only when it needs it', () => {
    expect(quoteExecArg('/usr/bin/framecapt')).toBe('/usr/bin/framecapt');
    expect(quoteExecArg('/home/a b/My App.AppImage')).toBe('"/home/a b/My App.AppImage"');
    expect(quoteExecArg('/x/$HOME/"q"')).toBe('"/x/\\$HOME/\\"q\\""');
    expect(quoteExecArg('/x/100%')).toBe('"/x/100%%"');
  });

  it('the entry starts the app hidden in the tray', () => {
    const text = autostartEntry('/usr/lib/framecapt/framecapt');
    expect(text).toContain('[Desktop Entry]');
    expect(text).toContain('Exec=/usr/lib/framecapt/framecapt --hidden\n');
    expect(text).toContain('Type=Application');
    expect(text).toContain('Terminal=false');
  });

  it('XDG_CONFIG_HOME wins when absolute, otherwise ~/.config', () => {
    const home = path.resolve('/home/ada');
    expect(autostartPath({ XDG_CONFIG_HOME: dir }, home)).toBe(
      path.join(dir, 'autostart', 'framecapt.desktop'),
    );
    expect(autostartPath({ XDG_CONFIG_HOME: 'relative' }, home)).toBe(
      path.join(home, '.config', 'autostart', 'framecapt.desktop'),
    );
    expect(autostartPath({}, home)).toBe(
      path.join(home, '.config', 'autostart', 'framecapt.desktop'),
    );
  });

  it('writes the file when enabled (AppImage path preferred) and removes it when disabled', () => {
    const env = { XDG_CONFIG_HOME: dir, execPath: '/opt/FrameCapt/framecapt' };
    const file = setAutostart(true, env);
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec=/opt/FrameCapt/framecapt --hidden');
    setAutostart(true, { ...env, APPIMAGE: '/home/ada/FrameCapt.AppImage' });
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec=/home/ada/FrameCapt.AppImage --hidden');
    setAutostart(false, env);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => setAutostart(false, env)).not.toThrow(); // already gone
  });
});

describe('windowIconFor', () => {
  const env = { isPackaged: false, appPath: '/repo', resourcesPath: '/opt/FrameCapt/resources' };

  it('Linux always gets the PNG: from the repository unpackaged, from resources packaged', () => {
    expect(windowIconFor('linux', env).icon).toBe(
      path.join('/repo', 'assets', 'brand', 'framecapt-logo-256.png'),
    );
    expect(windowIconFor('linux', { ...env, isPackaged: true }).icon).toBe(
      path.join('/opt/FrameCapt/resources', 'framecapt-logo-256.png'),
    );
  });

  it('Windows: the .ico only unpackaged (the packaged exe embeds its icon)', () => {
    expect(windowIconFor('win32', env).icon).toMatch(/framecapt\.ico$/);
    expect(windowIconFor('win32', { ...env, isPackaged: true })).toEqual({});
  });
});

describe('copyFfmpegResource (packaging: only the target platform ships)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-pack-'));
    const vendor = path.join(root, 'vendor');
    const builds: [string, string[]][] = [
      ['win32-x64', ['ffmpeg.exe', 'ffprobe.exe']],
      ['linux-x64', ['ffmpeg', 'ffprobe']],
    ];
    for (const [dir, files] of builds) {
      fs.mkdirSync(path.join(vendor, dir), { recursive: true });
      for (const file of files) fs.writeFileSync(path.join(vendor, dir, file), file);
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const packaged = (): string => path.join(root, 'pkg', 'resources', 'app');
  const resources = (): string => path.join(root, 'pkg', 'resources', 'ffmpeg');

  it('a Linux package gets the linux folder and no .exe', () => {
    copyFfmpegResource(path.join(root, 'vendor'), packaged(), 'linux', 'x64');
    expect(fs.readdirSync(resources())).toEqual(['linux-x64']);
    expect(fs.readdirSync(path.join(resources(), 'linux-x64')).sort()).toEqual([
      'ffmpeg',
      'ffprobe',
    ]);
  });

  it('a Windows package gets the win32 folder and no linux binary', () => {
    copyFfmpegResource(path.join(root, 'vendor'), packaged(), 'win32', 'x64');
    expect(fs.readdirSync(resources())).toEqual(['win32-x64']);
  });

  it('a missing build fails the package with the fix in the message', () => {
    expect(() =>
      copyFfmpegResource(path.join(root, 'vendor'), packaged(), 'linux', 'arm64'),
    ).toThrow(/npm run fetch:ffmpeg/);
  });
});

describe('fetch-ffmpeg targets', () => {
  it('pins a verified archive per platform, GPL, ffmpeg + ffprobe + LICENSE', async () => {
    // @ts-expect-error -- a plain .mjs build script without type declarations
    const { TARGETS } = (await import('../../scripts/fetch-ffmpeg.mjs')) as {
      TARGETS: Record<
        string,
        { sha256: string; url: string; files: Record<string, string>; kind: string }
      >;
    };
    expect(Object.keys(TARGETS).sort()).toEqual(['linux-x64', 'win32-x64']);
    for (const target of Object.values(TARGETS)) {
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(target.url.startsWith('https://github.com/')).toBe(true);
    }
    expect(TARGETS['linux-x64']?.kind).toBe('tar.xz');
    expect(Object.values(TARGETS['linux-x64']?.files ?? {}).sort()).toEqual([
      'LICENSE',
      'ffmpeg',
      'ffprobe',
    ]);
    expect(TARGETS['win32-x64']?.sha256).toBe(
      '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    );
  });
});
