/**
 * Native check of "a file on the clipboard" (src/main/clipboard/files.ts) with the REAL Electron
 * clipboard. It REPLACES whatever is on the clipboard. Run: `node scripts/check-clipboard-files.mjs`.
 *
 * Writes a `text/uri-list` for a file and a folder with awkward names (spaces, #, non-ASCII), reads
 * each back through Electron, and on Windows asks .NET (`Clipboard.GetFileDropList`) so the check
 * proves that a real CF_HDROP file list is on the clipboard, the format Explorer, Slack and Outlook
 * paste. (Electron 44 has no `clipboard.writeBuffer`; the `electron application/osclipboard`
 * "CF_HDROP" name registers a custom format that nothing reads, so it is not used.)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);

if (!process.versions.electron) {
  // Plain node: start Electron on this same file.
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [self], { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, clipboard, ClipboardItem } = await import('electron');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-clip-check-')));
  // Not `await app.whenReady()` at the top level: a pending top-level await keeps Electron from
  // ever becoming ready in an ESM main file.
  void app.whenReady().then(run);

  async function run() {
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push({ name, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc dir é '));
    const file = path.join(dir, 'FrameCapt 2026-10-07 at 14.05.09 (2) #1 é.mp4');
    const folder = path.join(dir, 'Step guide folder');
    fs.writeFileSync(file, 'x');
    fs.mkdirSync(folder);

    const fileDropList = () => {
      if (process.platform !== 'win32') return null;
      const run = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetFileDropList() -join "|"',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      return run.stdout.trim();
    };

    for (const [label, target] of [
      ['file', file],
      ['folder', folder],
    ]) {
      const uri = `${pathToFileURL(target).href}\r\n`;
      await clipboard.write([
        new ClipboardItem({ 'text/uri-list': new Blob([uri], { type: 'text/uri-list' }) }),
      ]);
      const [item] = await clipboard.read();
      check(
        `${label}: Electron reports text/uri-list`,
        item?.types.includes('text/uri-list') === true,
      );
      const back = item ? await (await item.getType('text/uri-list')).text() : '';
      check(`${label}: the URI list reads back unchanged`, back.trim() === uri.trim());
      const drop = fileDropList();
      if (drop !== null)
        check(`${label}: Windows has a real CF_HDROP file list`, drop === target, drop);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    const failed = results.filter((result) => !result.ok).length;
    console.log(
      failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} check(s) FAILED.`,
    );
    app.exit(failed === 0 ? 0 : 1);
  }
}
