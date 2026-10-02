import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

/**
 * Handles Squirrel.Windows installer lifecycle launches (--squirrel-install etc.). The installer
 * starts the app with these flags; we create/remove shortcuts and exit immediately.
 * Returns true when the process should quit without starting the UI. No update checks happen.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false;
  const event = process.argv[1];
  if (!event?.startsWith('--squirrel-')) return false;

  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
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
      run(['--removeShortcut', exeName]);
      return true;
    default: // --squirrel-obsolete and anything else
      app.quit();
      return true;
  }
}
