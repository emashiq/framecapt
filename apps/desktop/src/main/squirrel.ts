import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, shell } from 'electron';
import { DEFAULT_OUTPUT_SUBFOLDER } from '../shared/settings';
import { executeCleanup, listRealDir, planCaptureCleanup, realKindOf } from './uninstall';

/** Squirrel gives the uninstall hook about 15 s, then carries on without us. */
const PROMPT_TIMEOUT_MS = 8000;
const TRASH_DEADLINE_MS = 12_500;
const HARD_CAP_MS = 13_000;

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

/** Where FrameCapt's data and default capture folders are; read before userData is pointed elsewhere. */
interface UninstallPaths {
  userData: string;
  pictures: string;
  videos: string;
}

/**
 * FrameCapt is running when it holds Chromium's `lockfile` in its userData (an open file cannot be
 * deleted on Windows). A missing file means it is not running.
 */
function appIsRunning(userData: string): boolean {
  try {
    fs.rmSync(path.join(userData, 'lockfile'), { force: true });
    return false;
  } catch {
    return true;
  }
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Asks once whether to remove FrameCapt's data too (default, and no answer in time: keep). Remove
 * deletes the app data folder; with the checkbox, the captures also go to the Recycle Bin.
 */
async function offerDataRemoval(paths: UninstallPaths, startedAt: number): Promise<void> {
  if (process.env.FRAMECAPT_UNINSTALL_KEEP === '1') return;
  if (!fs.existsSync(paths.userData) || appIsRunning(paths.userData)) return;
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: 'Uninstall FrameCapt',
    message: 'Remove your FrameCapt data too?',
    detail:
      'This deletes your capture history, settings and editable screenshot projects. ' +
      'Your screenshots and recordings stay where they are unless you tick the box below.',
    buttons: ['Keep my data', 'Remove'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: 'Also move my screenshots and recordings to the Recycle Bin',
    checkboxChecked: false,
    signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
  });
  if (response !== 1) return;

  // The history says which captures are the app's; read it before the folder goes.
  const historyJson = checkboxChecked
    ? readOrNull(path.join(paths.userData, 'history', 'history.json'))
    : null;
  fs.rmSync(paths.userData, { recursive: true, force: true });
  if (!checkboxChecked) return;
  const plan = planCaptureCleanup({
    historyJson,
    defaultDirs: [paths.pictures, paths.videos].map((dir) =>
      path.join(dir, DEFAULT_OUTPUT_SUBFOLDER),
    ),
    listDir: listRealDir,
  });
  await executeCleanup(
    plan,
    { trash: (target) => shell.trashItem(target), kindOf: realKindOf, now: Date.now },
    startedAt + TRASH_DEADLINE_MS,
  );
}

/**
 * Handles Squirrel.Windows installer lifecycle launches (--squirrel-install etc.). The installer
 * starts the app with these flags; we create/remove shortcuts and exit immediately.
 * Returns true when the process should quit without starting the UI. No update checks happen.
 *
 * Uninstall removes the install folder, the shortcuts and the launch-at-login entry. User data
 * stays unless the user answers "Remove" to the question asked here (ADR-034): then
 * %APPDATA%\FrameCapt (settings, history, projects, sessions, logs) goes, and with a checkbox the
 * captures move to the Recycle Bin. No answer within 8 s, or a running FrameCapt, means keep.
 * Squirrel itself only ever deletes %LOCALAPPDATA%\FrameCapt.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false;
  const event = process.argv[1];
  if (!event?.startsWith('--squirrel-')) return false;
  // The first launch after an install: a normal run, not a lifecycle hook (it must not quit).
  if (event === '--squirrel-firstrun') return false;

  const updateExe = updateExePath(process.execPath);
  const exeName = path.basename(process.execPath);
  /** Runs Update.exe; resolves when it ends (or cannot start). */
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve) => {
      const child = spawn(updateExe, args, { detached: true, stdio: 'ignore', shell: false });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });

  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      void run(['--createShortcut', exeName]).then(() => app.quit());
      return true;
    case '--squirrel-uninstall': {
      const startedAt = Date.now();
      const paths: UninstallPaths = {
        userData: app.getPath('userData'),
        pictures: app.getPath('pictures'),
        videos: app.getPath('videos'),
      };
      // Chromium locks its data folders while it runs: point them at a scratch folder so the real
      // userData can be deleted.
      const scratch = path.join(os.tmpdir(), `framecapt-uninstall-${process.pid}`);
      for (const name of ['userData', 'sessionData', 'crashDumps'] as const) {
        app.setPath(name, scratch);
      }
      // Squirrel only waits so long: whatever is unfinished is abandoned.
      setTimeout(() => app.exit(0), HARD_CAP_MS).unref();
      // The launch-at-login entry points at the Update.exe that is about to disappear. The registry
      // write needs a ready app (before that it silently does nothing), so wait for it.
      void app.whenReady().then(async () => {
        try {
          app.setLoginItemSettings({ openAtLogin: false });
        } catch {
          // Best effort: a stale Run entry is harmless (it fails to start) and removable in Settings.
        }
        const shortcuts = run(['--removeShortcut', exeName]);
        try {
          await offerDataRemoval(paths, startedAt);
        } catch {
          // Keeping the data is always safe; an uninstaller has nobody to report to.
        }
        await shortcuts;
        app.quit();
      });
      return true;
    }
    default: // --squirrel-obsolete and anything else
      app.quit();
      return true;
  }
}
