/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

/**
 * Build-time update feed (Squirrel.Windows RELEASES base URL), injected by vite.main.config.ts from
 * the FRAMECAPT_UPDATE_URL environment variable at build time. Empty (the default) means updates
 * are not configured for this build: no update-API call and no network request is ever made.
 */
declare const __FRAMECAPT_UPDATE_URL__: string;
