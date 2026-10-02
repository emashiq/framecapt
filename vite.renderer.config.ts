import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PROD_CSP_META } from './src/shared/csp';

/**
 * Production CSP as a <meta> tag. The app:// protocol handler also sends the policy as a response
 * header (src/main/app-protocol.ts); the document carries it too, so it never depends on one layer.
 * Only injected in build mode; dev relies on the (more permissive) header from main.
 */
function injectProdCsp(): Plugin {
  let isBuild = false;
  return {
    name: 'framelet-inject-prod-csp',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!isBuild) return html;
        const meta = `<meta http-equiv="Content-Security-Policy" content="${PROD_CSP_META}" />`;
        // After <meta charset> (must stay within the first 1024 bytes), before any script.
        return html.replace(/(<meta charset[^>]*>)/i, `$1\n    ${meta}`);
      },
    },
  };
}

// https://vitejs.dev/config
export default defineConfig(({ mode }) => ({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  define: {
    // True only for E2E builds (FRAMELET_E2E_BUILD=1); the literal `false` otherwise, which
    // removes the synthetic frame generator from the bundle (scripts/check-no-mocks.mjs).
    __FRAMELET_E2E__: JSON.stringify(process.env.FRAMELET_E2E_BUILD === '1'),
  },
  // Forge's plugin sets outDir relative to root; pin it to the project's .vite directory.
  build: {
    outDir: path.resolve(import.meta.dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
    // Never inline assets: the CSP does not allow data: fonts, and we want real files.
    assetsInlineLimit: 0,
    sourcemap: mode !== 'production',
  },
  plugins: [react(), tailwindcss(), injectProdCsp()],
}));
