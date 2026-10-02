import { defineConfig } from 'vite';

// Sandboxed preloads can only require a small subset of modules, so shared code
// (the IPC contract) is bundled into the preload by Vite.
export default defineConfig({});
