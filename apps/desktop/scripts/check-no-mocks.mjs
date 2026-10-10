// Fails when a production build contains the mock capture provider or any E2E-only test hook.
// Usage: node scripts/check-no-mocks.mjs [--expect-mock] [--root <dir>]
// It scans the main and preload bundles (.vite/build), the renderer bundle (.vite/renderer) and,
// when one exists, the packaged app.asar (out/<app>/resources/app.asar), because that is the file
// that ships. --expect-mock is the positive control for builds made with FRAMECAPT_E2E_BUILD=1: it
// fails when the mock is NOT present in both the main bundle and the renderer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootArg = argv.indexOf('--root');
const root =
  rootArg === -1
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    : path.resolve(argv[rootArg + 1] ?? '.');
const expectMock = argv.includes('--expect-mock');

const buildDir = path.join(root, '.vite', 'build');
const rendererDir = path.join(root, '.vite', 'renderer');

// `FRAMECAPT_E2E` catches every E2E hook (env switches and the build constant's name) in one
// marker; the others name the mock modules themselves, which have no such prefix.
const markers = [
  'FRAMECAPT_E2E',
  '__FRAMECAPT_E2E__',
  'MockCaptureProvider',
  'MockWindowProbe',
  '__frameCaptProbe',
  'mock-provider',
  'Mock display',
  '__frameCaptTest',
  'drawSyntheticFrame',
  'synthetic-frame',
  'createSyntheticDisplayStream',
  'synthetic-stream',
];

if (!fs.existsSync(buildDir)) {
  console.error(
    `check-no-mocks: ${buildDir} does not exist. Build first (electron-forge package).`,
  );
  process.exit(2);
}

const jsFilesIn = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(c|m)?js$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

/** Every app.asar a packaged build left under out/ (files inside an asar are stored unpacked, so they can be searched as text). */
function asarFiles() {
  const out = path.join(root, 'out');
  if (!fs.existsSync(out)) return [];
  return fs
    .readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'app.asar')
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const files = [...jsFilesIn(buildDir), ...jsFilesIn(rendererDir)];
for (const required of ['main.cjs', 'preload.cjs']) {
  if (!files.some((file) => path.basename(file) === required)) {
    console.error(`check-no-mocks: .vite/build/${required} not found.`);
    process.exit(2);
  }
}
const asars = asarFiles();

const hits = [];
for (const file of [...files, ...asars]) {
  const text = fs.readFileSync(file, 'latin1');
  for (const marker of markers) {
    if (text.includes(marker)) hits.push(`${path.relative(root, file)}: ${marker}`);
  }
}

if (expectMock) {
  const inMain = hits.some((hit) => hit.startsWith('.vite' + path.sep + 'build'));
  const inRenderer = hits.some((hit) => hit.startsWith('.vite' + path.sep + 'renderer'));
  if (!inMain || !inRenderer) {
    console.error(
      `check-no-mocks: expected mock code in both the main bundle and the renderer of an E2E build (main: ${inMain}, renderer: ${inRenderer}).`,
    );
    process.exit(1);
  }
  console.log(`check-no-mocks: mock present as expected (${hits.length} marker hits).`);
} else if (hits.length > 0) {
  console.error('check-no-mocks: FAIL, mock or test-hook code found in the production build:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
} else {
  console.log(
    `check-no-mocks: OK (${files.length} bundle files and ${asars.length} app.asar scanned, no mock or test-hook markers).`,
  );
}
