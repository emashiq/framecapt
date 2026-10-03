import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    // True only for E2E builds (FRAMECAPT_E2E_BUILD=1). Normal builds get the literal `false`, so
    // the mock capture provider is removed from the bundle (checked by scripts/check-no-mocks.mjs).
    __FRAMECAPT_E2E__: JSON.stringify(process.env.FRAMECAPT_E2E_BUILD === '1'),
    // Squirrel update feed URL, compiled in. Empty (the default) = updates not configured for this
    // build: the update adapter does nothing and no network request is made (src/main/updates.ts).
    __FRAMECAPT_UPDATE_URL__: JSON.stringify(process.env.FRAMECAPT_UPDATE_URL ?? ''),
  },
});
