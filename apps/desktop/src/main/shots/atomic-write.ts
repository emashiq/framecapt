import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes `data` to a temp file in the target's directory, then renames it over the target, so a
 * crash or full disk never leaves a half-written image under the final name.
 */
export async function writeFileAtomic(target: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await fs.promises.open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, target);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}
