import fs from 'node:fs';
import path from 'node:path';

export interface LoginItemOptions {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

/** Launch arguments of a start at login: the app comes up in the tray, without its window. */
export const HIDDEN_ARG = '--hidden';

/**
 * What to pass to `app.setLoginItemSettings`. A Squirrel install runs the app through
 * `<install>/Update.exe --processStart <exe> --process-start-args --hidden`: registering the
 * versioned exe itself would break on the next update (Electron docs, "Squirrel.Windows").
 *
 * The arguments are passed WITHOUT quote characters. The Electron docs show `"${exeName}"` and
 * `'"--hidden"'`, but Electron 44 quotes and escapes every argument itself when it writes the Run
 * entry, so those literal quotes ended up inside the value (`--processStart "\"Framelet.exe\""`)
 * and Update.exe was asked to start a file named `"Framelet.exe"` (with the quotes): nothing
 * started at login. Found and measured by `npm run smoke:installed` (phase 10); the plain form
 * starts the app (a value that needs quoting, such as a name with a space, is quoted by Electron).
 */
export function loginItemOptions(
  openAtLogin: boolean,
  env: { execPath: string; exists?: (file: string) => boolean },
): LoginItemOptions {
  if (!openAtLogin) return { openAtLogin: false };
  const exists = env.exists ?? ((file: string) => fs.existsSync(file));
  const updateExe = path.resolve(path.dirname(env.execPath), '..', 'Update.exe');
  if (exists(updateExe)) {
    return {
      openAtLogin: true,
      path: updateExe,
      args: ['--processStart', path.basename(env.execPath), '--process-start-args', HIDDEN_ARG],
    };
  }
  return { openAtLogin: true, path: env.execPath, args: [HIDDEN_ARG] };
}
