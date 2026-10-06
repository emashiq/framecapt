import fs from 'node:fs';
import path from 'node:path';

/** A file name in `dir` that does not exist yet ("name.png", "name (2).png", ...). */
export async function freeFileName(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = path.join(dir, attempt === 1 ? fileName : `${stem} (${attempt})${ext}`);
    const taken = await fs.promises.access(candidate).then(
      () => true,
      () => false,
    );
    if (!taken) return candidate;
  }
  throw new Error('No free file name.');
}
