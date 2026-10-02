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
 * `<install>/Update.exe --processStart <exe>`: registering the versioned exe itself would break
 * on the next update (Electron docs, "Squirrel.Windows"). Anything else registers the running exe.
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
      args: [
        '--processStart',
        `"${path.basename(env.execPath)}"`,
        '--process-start-args',
        `"${HIDDEN_ARG}"`,
      ],
    };
  }
  return { openAtLogin: true, path: env.execPath, args: [HIDDEN_ARG] };
}
