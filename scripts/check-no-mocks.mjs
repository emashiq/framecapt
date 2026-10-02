// Fails when the production main bundle contains the mock capture provider.
// Usage: node scripts/check-no-mocks.mjs [--expect-mock]   (--expect-mock is the positive control
// for builds made with FRAMELET_E2E_BUILD=1: it fails when the mock is NOT present.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, '.vite', 'build');
const markers = [
  'MockCaptureProvider',
  'mock-provider',
  'Mock display',
  'FRAMELET_E2E_MOCK_CAPTURE',
  'drawSyntheticFrame',
  'synthetic-frame',
];
const expectMock = process.argv.includes('--expect-mock');

if (!fs.existsSync(buildDir)) {
  console.error(
    `check-no-mocks: ${buildDir} does not exist. Build first (electron-forge package).`,
  );
  process.exit(2);
}

const rendererDir = path.join(root, '.vite', 'renderer');
const jsFilesIn = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(c|m)?js$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

const files = [...jsFilesIn(buildDir), ...jsFilesIn(rendererDir)];
if (!files.some((file) => path.basename(file) === 'main.cjs')) {
  console.error('check-no-mocks: .vite/build/main.cjs not found.');
  process.exit(2);
}

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
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
  console.error('check-no-mocks: FAIL, mock code found in the production bundle:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
} else {
  console.log(`check-no-mocks: OK (${files.length} files scanned, no mock markers).`);
}
