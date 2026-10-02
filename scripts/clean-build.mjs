// Removes .vite (Vite build output) before packaging. Forge's Vite plugin does not empty the main
// build directory, so a mock-provider chunk from an E2E build would otherwise linger in a later
// production build and be packaged with it (and fail scripts/check-no-mocks.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, '.vite'), { recursive: true, force: true });
