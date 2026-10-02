import { execFileSync } from 'node:child_process';

/**
 * Global teardown for the Electron suites: ends any Electron main process (and its children) that
 * Playwright started and nobody closed. That only happens when a Playwright worker dies in the
 * middle of `electron.launch()` (see docs/testing.md); the app then waits forever for a debugger
 * that is gone and keeps its tray icon, its user-data lock and, outside the mock-shortcut E2E build,
 * the global shortcuts. Only processes started through Playwright's Electron loader from this
 * repository are touched, so a developer's own `npm start` is left alone.
 */
const FIND = `
$root = $env:FRAMELET_REPO_ROOT
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf('playwright-core', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf('loader.js', [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { $_.ProcessId }
`;

export function killOrphanElectron(root: string): number[] {
  if (process.platform !== 'win32') return [];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIND], {
    encoding: 'utf8',
    env: { ...process.env, FRAMELET_REPO_ROOT: root },
    windowsHide: true,
  });
  const pids = out
    .split(/\s+/)
    .filter((text) => /^\d+$/.test(text))
    .map(Number);
  for (const pid of pids) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Already gone.
    }
  }
  return pids;
}
