# Decisions

Short ADR-style records. Dates are 2026-10-02 unless noted.

## ADR-001: Stack and versions

Decision: Electron, TypeScript, React, Vite, Tailwind, zod, npm. Versions actually installed (lockfile is authoritative):

| Package                                                                   | Version                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| electron (pinned exactly)                                                 | 44.5.1 (Chromium 152.0.7977.130, Node 24.21.0 as reported by the running app) |
| @electron-forge/cli, plugin-vite, plugin-fuses, maker-squirrel, maker-zip | 8.0.1                                                                         |
| @electron/fuses                                                           | 2.1.3                                                                         |
| vite                                                                      | 8.3.2                                                                         |
| @vitejs/plugin-react                                                      | 6.1.1                                                                         |
| react / react-dom                                                         | 19.3.0                                                                        |
| typescript                                                                | 6.0.3                                                                         |
| tailwindcss / @tailwindcss/vite                                           | 4.3.3                                                                         |
| zod                                                                       | 4.6.5                                                                         |
| vitest                                                                    | 5.0.3                                                                         |
| @playwright/test                                                          | 1.63.0                                                                        |
| eslint / typescript-eslint / eslint-plugin-react-hooks                    | 10.11.0 / 8.71.0 / 7.1.1                                                      |
| prettier                                                                  | 3.9.9                                                                         |
| lucide-react / sonner / @radix-ui/react-tooltip                           | 1.49.0 / 2.0.8 / 1.2.16                                                       |
| @fontsource-variable/inter                                                | 5.3.0                                                                         |

Node 24.15.0 and npm 11.12.1 were used on the build host.

## ADR-002: Electron Forge with the Vite plugin

Decision: `@electron-forge/plugin-vite` 8.0.1 builds main, preload and renderer. Its peer range is not constrained, and Vite 8.3.2 builds and packages correctly with it (verified by `npm run package` and the e2e run), so no downgrade to Vite 7 was needed. The plugin emits `.cjs` bundles, so `package.json#main` is `.vite/build/main.cjs`.

The renderer config sets `root` to `src/renderer` and pins `build.outDir` to `.vite/renderer/main_window` (absolute) because the plugin's default `outDir` is relative to the root. `assetsInlineLimit: 0` keeps fonts as real files because the CSP does not allow `data:` fonts.

## ADR-003: One renderer entry with hash-based window roles

Decision: a single `main_window` renderer serves all window roles (`#/`, `#/overlay`, `#/toolbar`, `#/recorder`). Alternatives (one Vite entry per role) multiply build config and preload wiring for little benefit. The role registry in main (`webContents.id -> Role`) is what authorizes IPC, not the hash, so a page cannot elevate itself by changing its hash.

## ADR-004: npm and one lockfile

Decision: npm with a single `package-lock.json`; `npm ci` must succeed. No monorepo tooling.

## ADR-005: TypeScript 6.0, not 7

Decision: `typescript ~6.0.x`. typescript-eslint 8.71 declares `typescript >=4.8.4 <6.1.0`, and TypeScript 7.x (the latest published) is outside that range. Revisit when typescript-eslint supports 7.

## ADR-006: Electron fuses

Decision: `@electron-forge/plugin-fuses` with RunAsNode off, EnableCookieEncryption on, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on, OnlyLoadAppFromAsar on. `GrantFileProtocolExtraPrivileges` is left at its default (on) because the packaged app loads its own UI over `file://` and Vite's `type="module"` assets need it; the app never loads remote or user-supplied HTML, and navigation is locked down. Consequence: the packaged exe cannot be driven by Playwright (see ADR-008).

## ADR-007: CSP approach

Decision: enforce the policy in two layers. (1) Main sets `Content-Security-Policy` through `session.webRequest.onHeadersReceived`; dev additionally allows the Vite dev server origin, its websocket and inline script for the react-refresh preamble. (2) Production builds also embed the policy as a `<meta http-equiv>` tag via a small Vite `transformIndexHtml` plugin (build mode only). Observation: `onHeadersReceived` does fire for `file://` in Electron 44 on Windows, but the meta tag means production does not rely on that. Policy strings live in `src/shared/csp.ts` so the Vite config and main share one source.

## ADR-008: End-to-end test strategy

Decision: Playwright runs `electron .` against the Forge Vite output in `.vite/build` (produced by `electron-forge package`, which `npm run test:e2e` runs first), not the packaged exe, because the fuses disable `--inspect` arguments that Playwright needs. The build output loads the renderer over `file://` (no dev server URL is defined by `package`), so production CSP, sandbox and origin checks are exercised. A temporary `userData` directory is supplied through `FRAMELET_USER_DATA_DIR`, honored only when `!app.isPackaged`. The packaged exe is smoke-launched separately (process starts and stays alive) without Playwright.

## ADR-009: Result-style IPC and no raw errors

Decision: every invoke resolves to `{ ok, data } | { ok: false, error: { code, message } }`; even an unknown channel in the preload returns `UNKNOWN_CHANNEL` instead of throwing. Internal errors are logged in main and replaced by a generic message.

## ADR-010: Provisional app id

Decision: `com.framelet.app` is used as `packagerConfig.appBundleId` and as the Windows AppUserModelId. It is provisional and marked in `forge.config.ts` and `src/main/index.ts`. Owner action: confirm or replace it before any publication, because changing the AppUserModelId later breaks taskbar pinning and notification grouping.

## ADR-011: Squirrel lifecycle handling without auto-update

Decision: the Squirrel.Windows maker is configured and `src/main/squirrel.ts` handles the installer lifecycle launches (shortcut create/remove, `shell: false`). No update checks or feed URLs exist; update integration stays disabled until a real update source exists. The installer path has not been exercised on this host (`npm run make` was not run in phase 01).

## ADR-012: Styling

Decision: Tailwind v4 through `@tailwindcss/vite`. Colors are CSS variables defined with `light-dark()`, so they follow the system theme via `color-scheme`; `<html data-theme="light|dark">` overrides it for a future settings switch. Inter (variable) is bundled locally from `@fontsource-variable/inter` (OFL). Icons: lucide-react. Toasts: sonner. Tooltips: Radix.
