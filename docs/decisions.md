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
- **Resolved in phase 04 (lead decision): pixel-exact screenshot source.** `getDisplayMedia` frames are 4:2:0 video, so one pixel of color bleeds at hard saturated edges; a full-size `desktopCapturer` image is exact. SCREEN and REGION screenshots now come from ONE `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: <max physical width/height across displays>, fetchWindowIcons: false })` call per flow in main, mapped to displays by `display_id`. An image is used only if `getSize()` equals the display's physical size EXACTLY; otherwise that display falls back to the worker's `getDisplayMedia` frame and a warning is logged (it did not happen on the host: 9 of 9 freeze-frame grabs and 2 of 2 screen grabs exact). WINDOW screenshots first ask the worker for the video frame size, then request a window thumbnail at exactly that size and use it only when the size matches; on the host the thumbnail of the test window was 642x430 against a 642x432 frame, so the video frame was used (the path that ran is logged and recorded in the evidence). `getDisplayMedia` remains the method for recording and the fallback. Measured: magenta (255,0,255) on the first pixel inside and the exact backdrop color on the first pixel outside, 40 probes x 4 captures, tolerance 0 (phase 03: (217,28,216) and (79,16,79)). The freeze-frame no longer travels as PNG: the overlay gets raw BGRA bytes (encoding was ~110 ms per 3440x1440 screen), main keeps the `NativeImage` for the crop. The overlay windows are created hidden at the start of the flow and shown at opacity 0 only after the grab (a never-shown window renders at ~1 fps, which delayed the "painted" signal by 1-2 s); the main-measured request-to-visible time of the region overlays went from about 1.0-2.0 s (Playwright-measured in phase 03) to 0.68-0.79 s (see capture-feasibility.md).

## ADR-015: Screenshot editor: internal Canvas 2D, model separate from pixels (phase 04)

Decision: the editor is a small internal implementation on one `<canvas>`, not a canvas/design framework.

- **Why not a library.** The needed tools are six (select, crop, arrow, rectangle, text, redact) and the safety property is "the export is a flat raster whose redactions are solid pixels". A scene-graph library would add weight, own the rendering and make that property harder to reason about and test. The internal code (about 3,000 lines with the UI) is in four layers: pure model (`editor/model/`), a flatten function written against a minimal Canvas2D-like interface (`editor/flatten.ts`), view math (`editor/view.ts`) and React UI (`views/editor/`).
- **Model in image pixels, commands, immutable history.** Every coordinate is in pixels of the original capture, independent of zoom and devicePixelRatio; `zoom` is device pixels per image pixel and `screenToImage` is the only pointer conversion. Edits are commands over an immutable document (`apply`), history keeps whole documents (cheap through structural sharing) with 200 entries and gesture-key coalescing, and `dirty` is "present !== last saved document", so undoing back to the saved state is clean.
- **The model drives the export, never a stale canvas.** Save and Copy re-render the document from the decoded base image (`flattenToBlob`); a unit test undoes a redaction and shows the original pixels come back. The same `renderDoc` runs in Chromium (OffscreenCanvas) and against Skia in Node (`@napi-rs/canvas`, devDependency, MIT), so redaction pixels are tested for real in unit tests AND through Chromium's encoders in E2E (PNG file, JPEG file, clipboard).
- **Crop is non-destructive**: a document-level integer rectangle; annotations keep original coordinates; the editor dims the outside; export renders only the crop.
- **Radix** `alert-dialog` and `dropdown-menu` were added for the discard confirmation and the Save menu (focus trap, keyboard behavior, aria for free). They are small and already share the tooltip package's primitives.
- **Window close.** The renderer reports `editor:setDirty`; main intercepts the window's `close` through a pure `CloseGuard`: the first close with unsaved work asks the renderer (`app:confirmClose`), a second close while the question is open goes through, and `session-end` is never held up. There is no `beforeunload` hack. Automated tests quit with `app.exit()`.
- **Lifecycle of the original.** The original stays in `userData/shots/<id>/original.png` for editing and is deleted when the editor closes (Done, Discard, leaving the tab, closing the window); a save or copy does not delete it. Exported files are always the flattened result.

## ADR-016: Redaction rules: always on top, 1 px expansion, JPEG block padding (phase 04)

- **A redaction is always on top.** At export all redactions are drawn after every other annotation, so a later arrow, rectangle or text can never undercut one. The UI says so ("Redactions always cover everything beneath"). Hit testing follows the same order (redactions are picked first).
- **A redaction has no color and no opacity.** The type has neither field, `add` rebuilds it from its rectangle only, and `update` drops every other field; the export fills `#000000`, alpha 1, `source-over`. There is no way to express a translucent or blurred cover.
- **1 px expansion and integer snapping.** The rectangle is snapped outward to whole pixels and grown by one more pixel on each side, so no partially blended original pixel remains at an edge (fractional pointer positions such as 10.4 / 20.6 are normal at fit zoom).
- **JPEG block padding.** The brief's check "every pixel inside the redaction has max channel <= 8 after JPEG" does NOT hold with the 1 px expansion alone: on random noise at quality 0.92 the black pixels reached 24 (37 in a worst case) up to 14 px from the edge because compression spreads a hard edge through the 8x8 luma / 16x16 chroma blocks it crosses; quality 1.0 still left 14 (chroma upsampling reaches into the neighbouring block). For JPEG the cover therefore grows to the 16 px block grid of the output image plus a 2 px margin, so every block that touches the user's rectangle is entirely black (decoded value 0). Result: 0 in a Chromium-encoded JPEG and <= 8 in the Skia unit test, for rectangles with fractional coordinates, with and without a crop. The cost is that a JPEG redaction covers up to 17 px more on each side than the same redaction in PNG (the Save menu says so). It is the safe direction for a privacy feature; PNG stays exact.
- **Thumbnails.** History thumbnails must be made from the flattened output (`flattenThumbnail`), never from the original.

## ADR-017: Recorder state lives in main; one MediaRecorder, in the hidden window (phase 05)

- **Context.** Recording is started and stopped from several places (main window, toolbar, later tray and shortcuts), and the MediaRecorder needs a renderer (MediaStream, canvas, Web Audio).
- **Decision.** Main owns the only recorder state (`RecorderController` driving the pure machine in `src/shared/recorder-machine.ts`) and broadcasts snapshots. Windows send commands and render snapshots; none keeps its own copy. The only MediaRecorder lives in the hidden `recorder` window (`backgroundThrottling: false`), driven by `recorder:engineCommand` events and reporting by `recorder:engineEvent`; it asserts it is the only one and releases everything on every terminal path.
- **Consequences.** Idempotent stop is natural (a second STOP joins the first). The recorder window dying is just another stop reason (the session is finalized from disk). The extra round trip main <-> recorder is cheap compared with a 1 s timeslice. The brief's event list got three additions (STOPPED, MUTE_SET, AUDIO_LOST).
- **Constant frame rate.** Every recording goes through the canvas pipeline (even "Source" at native size), because a display track on a static screen delivers few frames and a timer-driven canvas gives a steady 30 fps (measured 29.7-30.5 fps in the hidden window, full 3440x1440 included). The cost is one canvas draw per frame.

## ADR-018: Chunk protocol: serial, acknowledged, bounded; minimal sink now, recovery later (phase 05)

- **Decision.** Chunks are numbered from 0, sent one at a time, each acknowledged after a real write, with a queue bounded at 16 chunks / 64 MB (overflow stops the recording with `QUEUE_OVERFLOW` and keeps what was accepted), a 16 MB cap per chunk, sequence validation in main (gap, conflict, idempotent repeat), an atomically rewritten manifest and a finish that verifies the last sequence number. The published file is a copy of `stream.webm` through temp file + rename.
- **Why not pass ArrayBuffers without acks.** An unacknowledged queue is unbounded memory and hides write failures until the end.
- **Known gap (phase 06).** MediaRecorder WebM has no duration or cues, so the output is not yet a "finalized" file; the session directory is kept after publishing; there is no recovery on restart and no disk-space pre-check.

## ADR-019: Toolbar and countdown: content protection first, placement as the second line (phase 05)

- **Decision.** The toolbar and the countdown window use `setContentProtection(true)`. This was measured, not assumed: on this host (Windows 11 10.0.26300, Electron 44.5.1, getDisplayMedia capture of a whole display) the toolbar's red Stop button was absent from the recorded frame (0 matching pixels where about 585 were expected), while with protection switched off the same detector found 460. For a region recording the toolbar is also placed just outside the region (below, else above, else another display), so it is not in the picture even if exclusion fails on another Windows version; only for a single display with a region that fills it does it have to sit inside, and then exclusion is the only protection. The countdown is closed before recording starts, and Esc cancels it through a global shortcut that exists only during the countdown (the window never takes focus).
- **Limits.** Verified on one Windows 11 build with the WGC/DXGI capture path Chromium uses there; older Windows 10 builds (before 2004) do not support `WDA_EXCLUDEFROMCAPTURE` and show a black box instead of excluding. The main window is minimized instead of excluded.

## ADR-020: Playback through a main-owned `framelet-media:` protocol (phase 05)

- **Decision.** The result view plays the finished file from `framelet-media://<id>`, a privileged scheme that serves only files main produced (id -> path map), answers Range requests itself (206/416) and is allowed in `media-src` of both CSPs. No file path or `file:` URL reaches the renderer for playback, and `blob:` URLs of the whole recording are never created.
- **Alternative rejected.** `net.fetch(file://...)` was not relied on for byte ranges.
