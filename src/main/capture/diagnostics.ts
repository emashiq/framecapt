import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, shell } from 'electron';
import { handle } from '../ipc';
import { log } from '../logger';

/** App-owned folder for diagnostics output. The renderer never supplies a path. */
export function diagnosticsDir(): string {
  return path.join(app.getPath('userData'), 'diagnostics');
}

let lastSaved: string | undefined;

/**
 * Diagnostics-only storage. Whole-blob saving is acceptable here because test recordings are
 * bounded (3-10 s, size-capped by the contract). Phase 06 replaces this with disk-backed sessions
 * for real recordings. Files are never deleted automatically.
 */
export function registerDiagnosticsHandlers(): void {
  handle('diagnostics:saveRecording', { roles: ['main'] }, async (request) => {
    const dir = diagnosticsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = request.ext === 'png' ? 'screenshot' : 'recording';
    const file = path.join(
      dir,
      `${prefix}-${stamp}-${randomBytes(3).toString('hex')}.${request.ext}`,
    );
    const bytes = Buffer.from(request.data);
    await fs.promises.writeFile(file, bytes, { flag: 'wx' });
    lastSaved = file;
    log.info(`Diagnostics file saved: ${path.basename(file)} (${bytes.byteLength} bytes)`);
    return { path: file, bytes: bytes.byteLength };
  });

  handle('diagnostics:revealFolder', { roles: ['main'] }, async () => {
    const dir = diagnosticsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const target = lastSaved && fs.existsSync(lastSaved) ? lastSaved : dir;
    shell.showItemInFolder(target);
  });
}
