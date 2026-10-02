// Records what `npm run make` produced: relative path, size and SHA-256 of every distributable,
// the Authenticode status of the installer (so "UNSIGNED" is a measurement, not a claim) and the
// versions that went in. Output: docs/evidence/phase10/artifacts.json (and SHA256SUMS.txt next to
// the artifacts, in out/make). Usage: npm run record:artifacts (after `npm run make`).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeDir = path.join(root, 'out', 'make');
if (!fs.existsSync(makeDir)) throw new Error(`${makeDir} not found. Run \`npm run make\` first.`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const provenancePath = path.join(root, 'vendor', 'ffmpeg', 'win32-x64', 'PROVENANCE.json');
const provenance = fs.existsSync(provenancePath)
  ? JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
  : null;

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function authenticode(file) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}').Status`,
    ],
    { shell: false, windowsHide: true, encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

const wanted = (name) => /\.(exe|zip|nupkg)$/i.test(name) || name === 'RELEASES';
const files = fs
  .readdirSync(makeDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && wanted(entry.name))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort();

const artifacts = files.map((file) => ({
  path: path.relative(root, file).replaceAll('\\', '/'),
  bytes: fs.statSync(file).size,
  sha256: sha256(file),
  ...(file.endsWith('.exe') && { authenticode: authenticode(file) }),
}));

const installer = artifacts.find((a) => a.path.endsWith('.exe'));
const evidence = {
  date: new Date().toISOString(),
  app: { name: pkg.productName, version: pkg.version },
  electron: pkg.devDependencies.electron,
  ffmpeg: provenance ? { version: provenance.version, sha256: provenance.sha256 } : null,
  signing:
    installer?.authenticode === 'NotSigned'
      ? 'UNSIGNED: no certificate was configured; Windows SmartScreen will warn'
      : `Authenticode status: ${installer?.authenticode ?? 'n/a'}`,
  artifacts,
};

const evidencePath = path.join(root, 'docs', 'evidence', 'phase10', 'artifacts.json');
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
fs.writeFileSync(
  path.join(makeDir, 'SHA256SUMS.txt'),
  `${artifacts.map((a) => `${a.sha256}  ${path.basename(a.path)}`).join('\n')}\n`,
);
for (const a of artifacts) console.log(`${a.sha256}  ${a.bytes}  ${a.path}`);
console.log(`signing: ${evidence.signing}`);
console.log(`evidence: ${path.relative(root, evidencePath)}`);
