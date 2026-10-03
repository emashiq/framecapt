import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HIDDEN_ARG } from './settings/login-item';

/**
 * Linux-only helpers (the experimental Linux x64 build, ADR-036). Everything is pure or takes its
 * environment as a parameter so it is unit-tested on any OS.
 */

/** The ozone platform FrameCapt forces: see ADR-036 (Wayland's portal picker cannot be used). */
export const LINUX_OZONE_PLATFORM = 'x11';

/**
 * Electron on Linux picks Wayland when the session has one. There, desktopCapturer and
 * getDisplayMedia go through the xdg-desktop-portal picker (PipeWire), which replaces FrameCapt's
 * main-owned source selection, and global shortcuts are limited. So the app runs on X11 (on a
 * Wayland session through XWayland). Must be called before `app` is ready.
 */
export function applyLinuxSwitches(
  commandLine: { appendSwitch(name: string, value?: string): void },
  platform: string = process.platform,
): void {
  if (platform !== 'linux') return;
  commandLine.appendSwitch('ozone-platform', LINUX_OZONE_PLATFORM);
  // Chromium's network service otherwise keeps connections open to Google hosts on Linux (seen in
  // the CI network test); FrameCapt makes no request of its own, so background networking is off.
  commandLine.appendSwitch('disable-background-networking');
  commandLine.appendSwitch('disable-component-update');
  commandLine.appendSwitch('disable-spell-checking');
}

/** `~/Pictures` / `~/Videos` when Electron cannot resolve the XDG user directory. */
export function defaultMediaFolders(
  getPath: (name: 'pictures' | 'videos') => string,
  home: string = os.homedir(),
): { pictures: string; videos: string } {
  const resolve = (name: 'pictures' | 'videos', fallback: string): string => {
    try {
      const value = getPath(name);
      if (value && path.isAbsolute(value)) return value;
    } catch {
      // The XDG directory is not configured: use the conventional one.
    }
    return path.join(home, fallback);
  };
  return { pictures: resolve('pictures', 'Pictures'), videos: resolve('videos', 'Videos') };
}

// --- launch at login (XDG autostart) ------------------------------------------------------------

export const AUTOSTART_FILE = 'framecapt.desktop';

/** Exec= values quote an argument with spaces or specials and escape `"` `` ` `` `$` `\`. */
export function quoteExecArg(arg: string): string {
  if (!/[\s"'`$\\<>~|&;*?#()%]/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

/** The autostart entry: starts FrameCapt hidden in the tray at login. */
export function autostartEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=FrameCapt',
    'Comment=Screenshots and screen recordings',
    `Exec=${quoteExecArg(execPath)} ${HIDDEN_ARG}`,
    'Icon=framecapt',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function autostartPath(env: { XDG_CONFIG_HOME?: string }, home: string = os.homedir()) {
  const base =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(home, '.config');
  return path.join(base, 'autostart', AUTOSTART_FILE);
}

/**
 * Writes or removes `<XDG config>/autostart/framecapt.desktop`. An AppImage starts through
 * `$APPIMAGE` (its mount point changes on every run), a .deb install through the executable.
 */
export function setAutostart(
  enabled: boolean,
  env: { XDG_CONFIG_HOME?: string; APPIMAGE?: string; execPath: string },
  home: string = os.homedir(),
): string {
  const file = autostartPath(env, home);
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, autostartEntry(env.APPIMAGE || env.execPath), { mode: 0o644 });
  } else {
    fs.rmSync(file, { force: true });
  }
  return file;
}
