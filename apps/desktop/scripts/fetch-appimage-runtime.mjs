// Fetches the pinned AppImage runtime (type2-runtime, MIT) into vendor/appimage-runtime/ for the
// Linux AppImage maker. The maker would otherwise download the moving `continuous` release at build
// time without checking it; this pins an immutable dated release and verifies its SHA-256 (a
// mismatch deletes the download and fails). Linux x64 only: a no-op everywhere else. Idempotent.
// Node built-ins only, no shell. See docs/packaging.md.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const RUNTIME = {
  tag: '20251108',
  url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimePath = path.join(repoRoot, 'vendor', 'appimage-runtime', 'runtime-x86_64');

function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.log('fetch-appimage-runtime: only needed for the Linux x64 AppImage; nothing to do.');
    return;
  }
  if (fs.existsSync(runtimePath) && sha256Of(runtimePath) === RUNTIME.sha256) {
    console.log(
      `fetch-appimage-runtime: runtime ${RUNTIME.tag} already in place (sha256 matches).`,
    );
    return;
  }
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  const temp = `${runtimePath}.download`;
  try {
    console.log(`fetch-appimage-runtime: downloading ${RUNTIME.url}`);
    const response = await fetch(RUNTIME.url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    const actual = sha256Of(temp);
    if (actual !== RUNTIME.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${RUNTIME.sha256}, got ${actual}. Deleted.`);
    }
    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, runtimePath);
    console.log('fetch-appimage-runtime: done (SHA-256 verified)');
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`fetch-appimage-runtime: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
