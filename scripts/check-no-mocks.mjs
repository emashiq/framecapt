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
];
const expectMock = process.argv.includes('--expect-mock');

if (!fs.existsSync(buildDir)) {
  console.error(
    `check-no-mocks: ${buildDir} does not exist. Build first (electron-forge package).`,
  );
  process.exit(2);
}

const files = fs.readdirSync(buildDir).filter((name) => /\.(c|m)?js$/.test(name));
if (!files.includes('main.cjs')) {
  console.error('check-no-mocks: .vite/build/main.cjs not found.');
  process.exit(2);
}

const hits = [];
for (const name of files) {
  const text = fs.readFileSync(path.join(buildDir, name), 'utf8');
  for (const marker of markers) if (text.includes(marker)) hits.push(`${name}: ${marker}`);
}

if (expectMock) {
  if (hits.length === 0) {
    console.error('check-no-mocks: expected the mock in an E2E build but found none.');
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
