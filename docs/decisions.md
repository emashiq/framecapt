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

## ADR-013: Browser capture pipeline, grants and region crop (phase 02)

Decision: keep capture in the renderer (`getDisplayMedia` + MediaRecorder) behind a main-process `CaptureProvider` for discovery and a main-owned authorization step.

- Authorization: `session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false })` answers only from a one-shot grant (5 s, bound to one webContents, source validated against a fresh `desktopCapturer` listing). Anything else calls back with `{}`, which rejects `getDisplayMedia` with `AbortError` in Electron 44; the renderer maps that to `denied`.
- Frame size: `track.getSettings()` is not trusted (on the second monitor it reported the other display's size until the first frame). The real frame size is read from the decoded frame.
- Screenshots: default method `auto` = `MediaStreamTrackProcessor` first, `<video>` + `requestVideoFrameCallback` as fallback (the video path waits for a new frame and was up to 2 s slow on a static screen).
- Region crop: canvas crop is the shipping candidate (works, correct pixels, 29-30 fps with a timer-backed driver). The track-processor crop also works and is cheaper but delivered 23-29 fps; keep it as a measured alternative, no switch yet. No native backend is needed on this evidence.
- Default recorder format: first supported of WebM VP9+Opus, VP8+Opus, H.264+Opus (runtime `isTypeSupported`).
- Mock provider: only in builds made with `FRAMELET_E2E_BUILD=1` (Vite `define`) plus a runtime env flag; `npm run check:mocks` fails if a normal bundle contains it.
- Diagnostics saves whole blobs (<= 200 MB, 3-10 s clips) into `userData/diagnostics/`. This is a prototype shortcut; phase 06 replaces it with disk-backed sessions.

## ADR-014: Screenshot workflow: freeze-frame regions, per-display overlays, main-owned paths (phase 03)

Decisions:

- **Freeze-frame regions.** Region selection happens on a frozen full-resolution frame of each display, shown in an opaque overlay, not on the live desktop. The frames are grabbed before any overlay exists (main window hidden, 200 ms settle), so no part of the selection UI can be in the output, the crop is a pure pixel operation on a known image, and the desktop cannot change between selecting and capturing. Cost: about 2 s from click to overlay on this host (two displays, hidden-window frame grabs) and the screen is "frozen" while selecting. A live overlay would need a second capture after closing the overlay and could race with changing content.
- **One overlay window per display** with `bounds = display.bounds`, instead of one window spanning the virtual desktop. Each overlay works in its own DIP space, so mixed scale factors and negative origins never enter the mapping, and a selection cannot cross displays by construction ("Selections stay on one screen"). Cost: several windows, and Electron's mixed-DPI placement quirk requires setting the bounds again after creation (verified with `getBounds`, mismatches are logged).
- **Hidden capture worker.** The 'recorder' role window is created lazily, stays hidden and does all `getDisplayMedia` work, so the main window can be hidden during a capture without stopping capture code. It is the same window that will own recording in phase 05.
- **Frame-ratio mapping.** Overlay DIP -> frame pixels uses frameWidth / bounds.width (and the height ratio), not `scaleFactor`; Chromium's frame size can differ from bounds x scale (rounding, fractional scales). Edges round outward then clamp. A frame whose orientation disagrees with the display (landscape frame, portrait display) is refused instead of cropped.
- **Main-owned paths.** Originals are written by main to `userData/shots/<uuid>/original.png`; the renderer only knows the id. Export goes through a main-process save dialog (default `Pictures/Framelet`) and an atomic temp-file + rename write; "show in folder" accepts only paths exported in this run; image bytes crossing IPC are validated by magic bytes and size. Originals of sessions that are never discarded stay until the 7-day startup sweep (a `keep` marker exempts one; phase 06/07 history will use it). Privacy trade-off: a screenshot the user abandoned can sit in userData for up to a week.
- **Clipboard.** Electron 44's `clipboard` is the promise-based W3C-style API (`write`, `read`); `clipboard.writeImage` does not exist, so `shot:copy` writes a `ClipboardItem` with an `image/png` blob.
- **E2E mock.** The E2E build (`npm run package:e2e`, `FRAMELET_E2E_BUILD=1`) compiles in the mock provider (two displays: scale 1 at (0,0), scale 1.5 at (-2293,0) with a 3440x1440 frame) and a synthetic frame generator in the renderer, both removed from normal builds (`check-no-mocks.mjs` now also scans the renderer bundle). `scripts/clean-build.mjs` runs before every package so a stale mock chunk can never be packaged.
- **Test scripts.** `npm run test:e2e` now builds with `scripts/package-e2e.mjs` (mock provider and synthetic frames compiled in, `check-no-mocks.mjs --expect-mock` as the positive control) and `npm run test:native` runs `npm run package` (normal build, `check:mocks` must pass). Both clean `.vite` first. This refines ADR-008.
- **Open question (not changed):** `getDisplayMedia` frames are 4:2:0 video, so one pixel of color bleeds at hard saturated edges; a full-size `desktopCapturer` thumbnail is exact. See capture-feasibility.md.
