// Fetches the pinned FFmpeg build of this platform into vendor/ffmpeg/<platform>-<arch>
// (gitignored): downloads the release archive, verifies its SHA-256 (a mismatch aborts and deletes
// the download), extracts ONLY the files listed below and writes PROVENANCE.json. Idempotent: it
// does nothing when the files exist and PROVENANCE.json records the same SHA-256.
//   win32-x64  Gyan essentials .zip, read with node:zlib (Node built-ins only)
//   linux-x64  BtbN linux64-gpl .tar.xz, extracted by the system `tar` (argument array, no shell)
// No PATH lookups for ffmpeg itself, no shell. See docs/ffmpeg.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const TARGETS = {
  'win32-x64': {
    kind: 'zip',
    version: '9.0.2',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
    sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    /** Folder inside the archive. */
    root: 'ffmpeg-9.0.2-essentials_build/',
    /** Entry path (inside the root) -> file name written. Nothing else is extracted. */
    files: {
      'bin/ffmpeg.exe': 'ffmpeg.exe',
      'bin/ffprobe.exe': 'ffprobe.exe',
      LICENSE: 'LICENSE',
      'README.txt': 'README.txt',
    },
    ffmpeg: 'ffmpeg.exe',
    build: 'Gyan essentials build',
  },
  // BtbN autobuild tags can be deleted by their owner some day: mirror the tarball (docs/ffmpeg.md).
  // The tag below is the release/9.0 branch (n9.0.2 + 22 commits, git 46d8f462ee), static, GPL.
  'linux-x64': {
    kind: 'tar.xz',
    version: '9.0.2',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz',
    sha256: 'a6170faecf757381ad0338d7a6ba26e97c2ebe2b9c1568633421e15d1ed436a9',
    root: 'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0/',
    files: {
      'bin/ffmpeg': 'ffmpeg',
      'bin/ffprobe': 'ffprobe',
      'LICENSE.txt': 'LICENSE',
    },
    ffmpeg: 'ffmpeg',
    build: 'BtbN linux64-gpl static build',
  },
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetName = `${process.platform}-${process.arch}`;
/** The pinned build of this platform, or undefined (nothing is pinned for macOS or arm64). */
export const FFMPEG = TARGETS[targetName];
const outDir = path.join(repoRoot, 'vendor', 'ffmpeg', targetName);
const provenancePath = path.join(outDir, 'PROVENANCE.json');

function readProvenance() {
  try {
    return JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  } catch {
    return null;
  }
}

function isInstalled() {
  const provenance = readProvenance();
  return (
    provenance?.sha256 === FFMPEG.sha256 &&
    Object.values(FFMPEG.files).every((name) => fs.existsSync(path.join(outDir, name)))
  );
}

async function download(target) {
  const response = await fetch(FFMPEG.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(target);
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, out);
  return hash.digest('hex');
}

/** The central directory of a zip file (no zip64: the build is far below 4 GB). */
function readCentralDirectory(fd, size) {
  const tailLength = Math.min(size, 66_000);
  const tail = Buffer.alloc(tailLength);
  fs.readSync(fd, tail, 0, tailLength, size - tailLength);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory).');
  const count = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  const dir = Buffer.alloc(dirSize);
  fs.readSync(fd, dir, 0, dirSize, dirOffset);
  const entries = new Map();
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    if (dir.readUInt32LE(pos) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = dir.readUInt16LE(pos + 10);
    const compressedSize = dir.readUInt32LE(pos + 20);
    const uncompressedSize = dir.readUInt32LE(pos + 24);
    const nameLength = dir.readUInt16LE(pos + 28);
    const extraLength = dir.readUInt16LE(pos + 30);
    const commentLength = dir.readUInt16LE(pos + 32);
    const localOffset = dir.readUInt32LE(pos + 42);
    const name = dir.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractEntry(fd, entry, target) {
  const local = Buffer.alloc(30);
  fs.readSync(fd, local, 0, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt zip local header.');
  const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const raw = fs.createReadStream(null, {
    fd,
    autoClose: false,
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
  });
  const steps = entry.method === 8 ? [raw, zlib.createInflateRaw()] : [raw];
  if (entry.method !== 8 && entry.method !== 0) {
    throw new Error(`Unsupported zip compression method ${entry.method}.`);
  }
  await pipeline(...steps, fs.createWriteStream(target));
  if (fs.statSync(target).size !== entry.uncompressedSize) {
    throw new Error('Extracted size does not match the zip entry.');
  }
}

function run(file, args) {
  const result = spawnSync(file, args, {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(file)} ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return result.stdout + result.stderr;
}

/** The license claim comes from the binary itself: -buildconf flags and the -L text. */
function verifyLicense(buildConfiguration, licenseText, build) {
  const has = (flag) => buildConfiguration.includes(flag);
  if (has('--enable-nonfree'))
    throw new Error('This FFmpeg build is non-free and not redistributable.');
  if (!has('--enable-gpl') || !has('--enable-version3')) {
    throw new Error('Unexpected FFmpeg build: not --enable-gpl --enable-version3.');
  }
  if (
    !/GNU General Public License as published by\s+the Free Software Foundation; either version 3/.test(
      licenseText,
    )
  ) {
    throw new Error('ffmpeg -L does not report GPL version 3 or later.');
  }
  return `GPL-3.0-or-later (${build}, --enable-gpl --enable-version3)`;
}

/** Extracts the listed members of a .tar.xz with the system tar (GNU or bsdtar; modes are kept). */
function extractTarXz(archive) {
  const members = Object.keys(FFMPEG.files).map((name) => FFMPEG.root + name);
  run('tar', ['-xJf', archive, '--strip-components=1', '-C', outDir, ...members]);
  for (const [entryName, fileName] of Object.entries(FFMPEG.files)) {
    const target = path.join(outDir, entryName);
    if (!fs.existsSync(target)) throw new Error(`The archive has no ${entryName}.`);
    fs.renameSync(target, path.join(outDir, fileName));
  }
  fs.rmSync(path.join(outDir, 'bin'), { recursive: true, force: true });
  for (const binary of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(outDir, binary), 0o755);
}

async function extractZip(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const entries = readCentralDirectory(fd, fs.fstatSync(fd).size);
    for (const [entryName, fileName] of Object.entries(FFMPEG.files)) {
      const entry = entries.get(FFMPEG.root + entryName);
      if (!entry) throw new Error(`The zip has no ${entryName}.`);
      await extractEntry(fd, entry, path.join(outDir, fileName));
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  if (!FFMPEG) {
    console.log(`fetch-ffmpeg: no FFmpeg build is pinned for ${targetName}; nothing to do.`);
    return;
  }
  if (isInstalled()) {
    console.log(`fetch-ffmpeg: FFmpeg ${FFMPEG.version} already in place (sha256 matches).`);
    return;
  }
  const temp = path.join(os.tmpdir(), `framecapt-ffmpeg-${process.pid}.${FFMPEG.kind}`);
  let touched = false;
  try {
    console.log(`fetch-ffmpeg: downloading ${FFMPEG.url}`);
    const actual = await download(temp);
    if (actual !== FFMPEG.sha256) {
      throw new Error(
        `SHA-256 mismatch: expected ${FFMPEG.sha256}, got ${actual}. Download deleted.`,
      );
    }
    console.log(
      `fetch-ffmpeg: SHA-256 verified; extracting ${Object.keys(FFMPEG.files).length} files`,
    );
    touched = true;
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    if (FFMPEG.kind === 'zip') await extractZip(temp);
    else extractTarXz(temp);
    const ffmpeg = path.join(outDir, FFMPEG.ffmpeg);
    const buildConfiguration = run(ffmpeg, ['-hide_banner', '-buildconf'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('--'));
    const license = verifyLicense(buildConfiguration, run(ffmpeg, ['-L']), FFMPEG.build);
    const versionLine = run(ffmpeg, ['-version']).split(/\r?\n/)[0];
    fs.writeFileSync(
      provenancePath,
      `${JSON.stringify(
        {
          url: FFMPEG.url,
          sha256: FFMPEG.sha256,
          version: FFMPEG.version,
          versionLine,
          fetchedAt: new Date().toISOString(),
          buildConfiguration,
          license,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`fetch-ffmpeg: done (${versionLine})`);
  } catch (error) {
    // Never leave a half-populated vendor directory behind.
    if (touched) fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`fetch-ffmpeg: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
