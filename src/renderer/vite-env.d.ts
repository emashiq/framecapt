/// <reference types="vite/client" />

/**
 * Build-time constant from vite.renderer.config.ts: true only for E2E builds
 * (FRAMELET_E2E_BUILD=1), otherwise the literal `false`, which removes the synthetic frame code.
 */
declare const __FRAMELET_E2E__: boolean;
