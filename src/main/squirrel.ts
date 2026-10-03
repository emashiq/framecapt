import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

/** Squirrel package id: the MakerSquirrel `name` in forge.config.ts (PROVISIONAL). */
const SQUIRREL_PACKAGE = 'FrameCapt';
/** PROVISIONAL app id of unpackaged runs and the portable zip (also in forge.config.ts). */
const DEFAULT_APP_USER_MODEL_ID = 'com.framecapt.app';

/** `<install root>\Update.exe`: present only in a Squirrel install, never in the portable zip or dev. */
function updateExePath(execPath: string): string {
  return path.resolve(path.dirname(execPath), '..', 'Update.exe');
}

/**
 * The Windows AppUserModelID. Squirrel stamps its Start Menu shortcut with
 * `com.squirrel.<package>.<exe name>`; notifications only group under the app (and keep its name
 * and icon) when the process uses the same id (Electron docs, Notifications / Squirrel.Windows).
 * Everything that is not a Squirrel install keeps the provisional app id.
 */
export function appUserModelId(
  execPath: string,
  exists: (file: string) => boolean = fs.existsSync,
): string {
  if (!exists(updateExePath(execPath))) return DEFAULT_APP_USER_MODEL_ID;
  const exeName = path.basename(execPath, path.extname(execPath)).replaceAll(' ', '');
  return `com.squirrel.${SQUIRREL_PACKAGE}.${exeName}`;
}

/**
 * Handles Squirrel.Windows installer lifecycle launches (--squirrel-install etc.). The installer
 * starts the app with these flags; we create/remove shortcuts and exit immediately.
 * Returns true when the process should quit without starting the UI. No update checks happen.
 *
 * Uninstall removes the install folder, the shortcuts and the launch-at-login entry. It never
 * touches user data: %APPDATA%\FrameCapt (settings, history, sessions, logs) stays, and so do the
 * capture folders (Pictures\FrameCapt, Videos\FrameCapt) or any other output folder. Squirrel
 * itself only ever deletes %LOCALAPPDATA%\FrameCapt.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false;
  const event = process.argv[1];
  if (!event?.startsWith('--squirrel-')) return false;
  // The first launch after an install: a normal run, not a lifecycle hook (it must not quit).
  if (event === '--squirrel-firstrun') return false;

  const updateExe = updateExePath(process.execPath);
  const exeName = path.basename(process.execPath);
  const run = (args: string[]): void => {
    const child = spawn(updateExe, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => app.quit());
    child.on('close', () => app.quit());
  };

  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      run(['--createShortcut', exeName]);
      return true;
    case '--squirrel-uninstall':
      // The launch-at-login entry points at the Update.exe that is about to disappear. The registry
      // write needs a ready app (before that it silently does nothing), so wait for it.
      void app.whenReady().then(() => {
        try {
          app.setLoginItemSettings({ openAtLogin: false });
        } catch {
          // Best effort: a stale Run entry is harmless (it fails to start) and removable in Settings.
        }
        run(['--removeShortcut', exeName]);
      });
      return true;
    default: // --squirrel-obsolete and anything else
      app.quit();
      return true;
  }
}
