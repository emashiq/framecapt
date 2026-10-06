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

Decision: `@electron-forge/plugin-fuses` with RunAsNode off, EnableCookieEncryption on, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on, OnlyLoadAppFromAsar on. `GrantFileProtocolExtraPrivileges` was left on in phases 01-09 because the UI was a `file://` page; **phase 10 turned it off** after serving the UI from `app://framecapt` (ADR-033). Consequence: the packaged exe cannot be driven by Playwright (see ADR-008).

## ADR-007: CSP approach

Decision: enforce the policy in two layers. (1) Main sets `Content-Security-Policy` through `session.webRequest.onHeadersReceived`; dev additionally allows the Vite dev server origin, its websocket and inline script for the react-refresh preamble. (2) Production builds also embed the policy as a `<meta http-equiv>` tag via a small Vite `transformIndexHtml` plugin (build mode only). Observation: `onHeadersReceived` does fire for `file://` in Electron 44 on Windows, but the meta tag means production does not rely on that. Policy strings live in `src/shared/csp.ts` so the Vite config and main share one source.

## ADR-008: End-to-end test strategy

Decision: Playwright runs `electron .` against the Forge Vite output in `.vite/build` (produced by `electron-forge package`, which `npm run test:e2e` runs first), not the packaged exe, because the fuses disable `--inspect` arguments that Playwright needs. The build output loads the renderer from `app://framecapt` (no dev server URL is defined by `package`; `file://` before phase 10), so production CSP, sandbox and origin checks are exercised. A temporary `userData` directory is supplied through `FRAMECAPT_USER_DATA_DIR`, honored only when `!app.isPackaged`. The packaged exe is smoke-launched separately (process starts and stays alive) without Playwright.

## ADR-009: Result-style IPC and no raw errors

Decision: every invoke resolves to `{ ok, data } | { ok: false, error: { code, message } }`; even an unknown channel in the preload returns `UNKNOWN_CHANNEL` instead of throwing. Internal errors are logged in main and replaced by a generic message.

## ADR-010: Provisional app id

Decision: `com.framecapt.app` is used as `packagerConfig.appBundleId` and as the Windows AppUserModelId. It is provisional and marked in `forge.config.ts` and `src/main/index.ts`. Owner action: confirm or replace it before any publication, because changing the AppUserModelId later breaks taskbar pinning and notification grouping.

## ADR-011: Squirrel lifecycle handling without auto-update

Decision: the Squirrel.Windows maker is configured and `src/main/squirrel.ts` handles the installer lifecycle launches (shortcut create/remove, `shell: false`). No update checks or feed URLs exist; update integration stays disabled until a real update source exists. Phase 10 exercised it on this host: silent install, shortcuts, uninstall (see ADR-034 and `docs/evidence/phase10/installed-smoke.json`).

## ADR-012: Styling

Decision: Tailwind v4 through `@tailwindcss/vite`. Colors are CSS variables defined with `light-dark()`, so they follow the system theme via `color-scheme`; `<html data-theme="light|dark">` overrides it for a future settings switch. Inter (variable) is bundled locally from `@fontsource-variable/inter` (OFL). Icons: lucide-react. Toasts: sonner. Tooltips: Radix.

## ADR-013: Browser capture pipeline, grants and region crop (phase 02)

Decision: keep capture in the renderer (`getDisplayMedia` + MediaRecorder) behind a main-process `CaptureProvider` for discovery and a main-owned authorization step.

- Authorization: `session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false })` answers only from a one-shot grant (5 s, bound to one webContents, source validated against a fresh `desktopCapturer` listing). Anything else calls back with `{}`, which rejects `getDisplayMedia` with `AbortError` in Electron 44; the renderer maps that to `denied`.
- Frame size: `track.getSettings()` is not trusted (on the second monitor it reported the other display's size until the first frame). The real frame size is read from the decoded frame.
- Screenshots: default method `auto` = `MediaStreamTrackProcessor` first, `<video>` + `requestVideoFrameCallback` as fallback (the video path waits for a new frame and was up to 2 s slow on a static screen).
- Region crop: canvas crop is the shipping candidate (works, correct pixels, 29-30 fps with a timer-backed driver). The track-processor crop also works and is cheaper but delivered 23-29 fps; keep it as a measured alternative, no switch yet. No native backend is needed on this evidence.
- Default recorder format: first supported of WebM VP9+Opus, VP8+Opus, H.264+Opus (runtime `isTypeSupported`).
- Mock provider: only in builds made with `FRAMECAPT_E2E_BUILD=1` (Vite `define`) plus a runtime env flag; `npm run check:mocks` fails if a normal bundle contains it.
- Diagnostics saves whole blobs (<= 200 MB, 3-10 s clips) into `userData/diagnostics/`. This is a prototype shortcut; phase 06 replaces it with disk-backed sessions.

## ADR-014: Screenshot workflow: freeze-frame regions, per-display overlays, main-owned paths (phase 03)

Decisions:

- **Freeze-frame regions.** Region selection happens on a frozen full-resolution frame of each display, shown in an opaque overlay, not on the live desktop. The frames are grabbed before any overlay exists (main window hidden, 200 ms settle), so no part of the selection UI can be in the output, the crop is a pure pixel operation on a known image, and the desktop cannot change between selecting and capturing. Cost: about 2 s from click to overlay on this host (two displays, hidden-window frame grabs) and the screen is "frozen" while selecting. A live overlay would need a second capture after closing the overlay and could race with changing content.
- **One overlay window per display** with `bounds = display.bounds`, instead of one window spanning the virtual desktop. Each overlay works in its own DIP space, so mixed scale factors and negative origins never enter the mapping, and a selection cannot cross displays by construction ("Selections stay on one screen"). Cost: several windows, and Electron's mixed-DPI placement quirk requires setting the bounds again after creation (verified with `getBounds`, mismatches are logged).
- **Hidden capture worker.** The 'recorder' role window is created lazily, stays hidden and does all `getDisplayMedia` work, so the main window can be hidden during a capture without stopping capture code. It is the same window that will own recording in phase 05.
- **Frame-ratio mapping.** Overlay DIP -> frame pixels uses frameWidth / bounds.width (and the height ratio), not `scaleFactor`; Chromium's frame size can differ from bounds x scale (rounding, fractional scales). Edges round outward then clamp. A frame whose orientation disagrees with the display (landscape frame, portrait display) is refused instead of cropped.
- **Main-owned paths.** Originals are written by main to `userData/shots/<uuid>/original.png`; the renderer only knows the id. Export goes through a main-process save dialog (default `Pictures/FrameCapt`) and an atomic temp-file + rename write; "show in folder" accepts only paths exported in this run; image bytes crossing IPC are validated by magic bytes and size. Originals of sessions that are never discarded stay until the 7-day startup sweep (a `keep` marker exempts one; phase 06/07 history will use it). Privacy trade-off: a screenshot the user abandoned can sit in userData for up to a week.
- **Clipboard.** Electron 44's `clipboard` is the promise-based W3C-style API (`write`, `read`); `clipboard.writeImage` does not exist, so `shot:copy` writes a `ClipboardItem` with an `image/png` blob.
- **E2E mock.** The E2E build (`npm run package:e2e`, `FRAMECAPT_E2E_BUILD=1`) compiles in the mock provider (two displays: scale 1 at (0,0), scale 1.5 at (-2293,0) with a 3440x1440 frame) and a synthetic frame generator in the renderer, both removed from normal builds (`check-no-mocks.mjs` now also scans the renderer bundle). `scripts/clean-build.mjs` runs before every package so a stale mock chunk can never be packaged.
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

## ADR-020: Playback through a main-owned `framecapt-media:` protocol (phase 05)

- **Decision.** The result view plays the finished file from `framecapt-media://<id>`, a privileged scheme that serves only files main produced (id -> path map), answers Range requests itself (206/416) and is allowed in `media-src` of both CSPs. No file path or `file:` URL reaches the renderer for playback, and `blob:` URLs of the whole recording are never created.
- **Alternative rejected.** `net.fetch(file://...)` was not relied on for byte ranges.

## ADR-021: Finalize by FFmpeg remux; the session directory does not outlive its output (phase 06)

- **Context.** MediaRecorder WebM is one continuous stream with no Duration and no Cues; phase 05 published a byte copy of it and kept the session directory (a full duplicate).
- **Decision.** Finalization is `ffmpeg -c copy -map 0 -f webm` into `.framecapt-<sessionId>.partial.webm` in the output folder (same volume, so the rename is atomic), a probe (video stream and duration > 0), an atomic rename to a free name, and only then: manifest `completed`, a small `completed/<id>.json` record (output path, duration, size, pauses; for history linking in phase 07), and deletion of the whole session directory including `stream.webm`. If the record cannot be written only the duplicate `stream.webm` is removed.
- **Failure policy.** A failed remux keeps `stream.webm` and a `finalize.log` (ffmpeg stderr tail). If the raw stream shows a video stream it is copied out as a last resort and the result says so ("Saved without a seeking index"; `unindexed`), and `stream.webm` is KEPT in that case (the manifest is `failed`, the next start offers Recover again), because a raw copy is not a successful finalization. Out of space on the output volume refuses the remux (`LOW_DISK`) instead of half-writing.
- **Alternatives rejected.** Re-encoding (slow, lossy, pointless for VP9/Opus already in WebM); keeping `stream.webm` after success "just in case" (a 100 percent duplicate; a failed probe is the safety net); remuxing with `-fflags +genpts`/re-timing (changes timestamps; copy as-is unless a measured defect appears).

## ADR-022: A pinned, hash-verified FFmpeg fetched by a dependency-free script (phase 06, pulled forward from 07)

- **Decision.** gyan.dev/GyanD 9.0.2 "essentials" Windows x64 (GPL-3.0-or-later: `--enable-gpl --enable-version3`, no `--enable-nonfree`, verified from `-buildconf` and `-L` by the fetch script itself). `scripts/fetch-ffmpeg.mjs` downloads the zip, checks the SHA-256 (mismatch deletes the download and aborts), extracts only `ffmpeg.exe`, `ffprobe.exe`, `LICENSE`, `README.txt` with a 60 line zip reader on `node:zlib` (no Python on this host, no PowerShell dependency, no new package), writes `PROVENANCE.json`, and is idempotent. It runs from the npm hooks `prestart`, `prepackage`, `prepackage:e2e`, `premake`. The binary is never taken from `PATH` and no renderer value reaches a command line.
- **Packaging.** `extraResource: ['vendor/ffmpeg']` lands at `resources/ffmpeg/win32-x64/` (extraResource keeps the folder's own name). About 211 MB uncompressed for two static executables; a trimmed custom build is a later optimization. Redistribution under the GPL needs the third-party notice and a source offer (phase 11, owner action).
- **Alternatives rejected.** `yauzl` (a dependency for 60 lines of code); `Expand-Archive` (extracts all 400+ files and the 3 executables, slower); WinGet/PATH ffmpeg (not reproducible, not shippable).

## ADR-023: Recovery is best effort and says so (phase 06)

- **Decision.** On start, `RecoveryService` re-runs interrupted finalizations once (deleting only the partial file the manifest names whose file name carries the session id), removes leftovers of finished and discarded sessions, and lists unfinished sessions with data. The user decides: Recover (remux of what is on disk; success is announced only after a probe shows a video stream and a real duration, and the copy says "Recovered what could be saved", never "lossless") or Discard (confirmation; only a uuid directory inside `userData/recordings` whose manifest names the same id). An unreadable manifest is preserved as `manifest.corrupt.json` and replaced by a minimal one so the session stays recoverable but is reported as `unknown`.
- **Unrepairable.** A stream that cannot be remuxed stays on disk with its log; the card says it could not be repaired, shows where the raw data is and offers Reveal and Discard.
- **Why not recover automatically.** A recovered file lands in the user's folder; the user may prefer to discard junk. Only the interrupted finalization (a recording that had ended normally) is finished without asking.
- **Measured limits.** See docs/recording-persistence.md section 8.

## ADR-024: Disk thresholds and write failure behavior (phase 06)

- **Decision.** Start refuses below 1 GB free (`LOW_DISK`); while recording the free space of the `userData` volume is read every 30 s with `fs.statfs` and below 500 MB the recording is stopped through the existing write-failed path (`DISK_LOW`) and what was written is finalized (the result says it stopped early). A remux needs the stream's size plus 100 MB free on the output volume. `ENOSPC`/`EDQUOT` (`DISK_FULL`), `EIO`, `EACCES`, `EPERM` (`WRITE_FAILED`) on a chunk write close the session as `failed` and keep `stream.webm`. Thresholds are constants (`session-fs.ts`), not settings; they are a starting point to revise with phase 09 measurements.
- **Limit.** 30 s is a polling interval: at 30 Mbps (3.75 MB/s) the disk can lose about 110 MB between checks, which the 500 MB margin absorbs. The check cannot see quotas other than `statfs` reports.

## ADR-025: History is metadata beside the user's files; entries come from main, never from a path (phase 07)

- **Decision.** `userData/history/history.json` (versioned, zod, atomic writes) stores facts and a pointer per capture; the files stay where the user saved them. Items are created only by main when it produces an output (screenshot export, finalized or recovered recording, MP4 export), with ids made in main; every action (`open`, `reveal`, `copy*`, `remove`, `deleteFile`, `relink`, `saveCopy`, `export:mp4`) takes only that id. `relink` is the one place a path enters, and it comes from an open dialog in main and is checked by extension and content.
- **Missing files** stay listed ("File moved or deleted") because a calm, recoverable state beats silently losing the record; the user decides (Locate, Remove, Clear missing). Corruption moves the file aside (`history.json.corrupt-<time>`) and starts empty with a one-time notice: data about the user's files is not worth blocking the app for, and the files are never touched. The cap (1000) drops the oldest entries from the list only.
- **Remove vs delete.** "Remove from history" never touches a file and has a 5 s Undo (main keeps the removed entry for 15 s, so the renderer cannot inject data). "Delete file" is a separate, named, confirmed action that uses `shell.trashItem` (Recycle Bin), never a permanent unlink, is not reachable from the keyboard shortcut for removal, and leaves the entry in place if the Recycle Bin refuses.
- **Alternatives rejected.** Storing paths the renderer reports (a compromised renderer could point history at any file); auto-pruning missing entries (a file on a disconnected drive would lose its record); permanent delete (no way back).

## ADR-026: History thumbnails come only from flattened output (phase 07)

- **Decision.** A screenshot's history thumbnail is the PNG the editor draws from the flattened result (`flattenThumbnail`, redactions applied, at most 480 px) and sends along with `shot:export`; main validates magic, size and width, and stores it. Main never decodes the original capture to make a thumbnail, so a redacted secret cannot reach the history folder through a code path that forgot the redaction. Without a thumbnail (the editor could not draw one) the entry shows a placeholder. Recording thumbnails are one ffmpeg frame of the finished file (a recording has no redaction layer). Thumbnails live in a bounded folder (200 MB, oldest first) apart from user files and are deleted when nothing refers to them.
- **Rescan exception.** "Find existing captures" (`history:rescan`, and once on a fresh start) adds image files already sitting in the output folders. Those files are final, flattened output, so main makes their thumbnail from the file itself; this does not reopen the redaction path above, which concerns unflattened originals.
- **Verified** in E2E: with a redaction over the middle of the picture, the thumbnail's centre pixel is exactly (0,0,0) and a far pixel is the original gradient.

## ADR-027: MP4 only with a verified encoder, through a partial file, one at a time (phase 07)

- **Decision.** MP4 export is offered only when `ffmpeg -encoders` reports `libx264` and the native `aac` encoder. The conversion writes a uniquely named partial file next to the destination, verifies it with ffprobe (container, H.264, AAC if the source had audio, duration within 0.5 s) and renames it; every other outcome deletes just that partial file. The original is only read. One export runs at a time (x264 uses all cores; two jobs would only slow each other). Flags and measurements: docs/ffmpeg.md.
- **WebM "export".** The finalized WebM in `Videos/FrameCapt` already is the deliverable; "Save a copy as..." copies it through a temp file and a rename. An extension is never changed to convert.
- **Open item.** H.264/AAC patent licensing for distribution is an owner decision before a commercial release; the app degrades cleanly (MP4 reported unavailable) if the answer is to drop it.

## ADR-028: `framecapt-media:` gains two strict history routes and `img-src` (phase 07)

- **Decision.** `framecapt-media://thumb/<history id>` and `framecapt-media://file/<history id>` resolve through history only (ids made in main); the registry route of phase 05 is unchanged. A query, fragment, port, user info, extra segment or unknown id is a 404, as is any extension the app does not produce. The CSP allows `framecapt-media:` in `img-src` (for thumbnails and image previews) in addition to `media-src`; it is still absent from `script-src`, `connect-src`, `style-src` and `font-src`, and a renderer `fetch` of such a URL is blocked by `connect-src`.
- **Alternatives rejected.** Data URLs of thumbnails in `history:list` (every list would carry up to 1000 images over IPC); `file://` access (breaks the "main owns paths" rule and the CSP).

## ADR-029: Settings are one validated file in main; the renderer mirrors it (phase 08)

`settings.json` is versioned, zod-validated with defaults, written atomically and debounced, and repaired by setting a damaged file aside (never by guessing). Main owns it; the renderer applies a change at once, sends it, and lets main's answer win. Output folders cannot travel in a patch: they come from a main-process dialog plus a write probe, so a renderer can neither name a path nor set a folder that cannot be written. Launch-at-login is opt-in, written only on the user's toggle and only by a packaged build (an unpackaged run would register the bare Electron binary); Squirrel installs register through `Update.exe` as Electron's docs prescribe. Alternatives rejected: localStorage (per-window, invisible to main, cannot drive shortcuts or the tray), a settings service per window.

## ADR-030: Global shortcuts: own only what we registered, report every conflict, one set of flows (phase 08)

`globalShortcut.register` failing (another app holds the combination) is a visible per-action status, not a log line. The manager unregisters only accelerators it registered itself. The shortcut recorder releases them while listening. A modifier (Ctrl or Alt) is required except for F-keys and PrintScreen; PrintScreen is not a default (the Snipping Tool owns it). Shortcuts, tray and buttons share the flow functions; a record shortcut while recording stops (toggle), screenshots are refused while anything runs, and anything that needs a picker or would replace unsaved editor work is routed through the main window. Defaults Ctrl+Shift+1/2/3, 5/6/7, 0, 9 follow the brief; known in-app uses of these keys by other software (Windows Terminal, VS Code) and Windows' input-language hot keys are documented in `keyboard-shortcuts.md`. In E2E builds a fake `globalShortcut` keeps the suite from grabbing real system keys; real registration, conflict and OS key presses are verified natively.

## ADR-031: Strictly increasing timestamps are enforced at remux; the CFR "dts" message is a tool artifact (phase 08)

Investigation (80 synthetic recordings through the real pipeline, with and without pauses): the file-level defect is that MediaRecorder sometimes stamps the first two frames within the same millisecond (2 of 30 before the fix: packets `0, 0, 32, 65`). Elsewhere frame times are valid variable-frame-rate stamps, a few ms off an ideal 30 fps grid; ffmpeg's decode-to-null defaults to constant frame rate and then reports "non monotonically increasing dts to muxer ... 53 >= 53" when two frames land in one 33 ms slot (1 of 30 before; 2 of 40 after), with `-fps_mode vfr` the same files decode cleanly. Decision: fix what is wrong in the file (the remux adds `-bsf setts` so no timestamp fails to increase; payload untouched, no frame added or dropped, verified by packet counts) and make the tests check what matters: packet timestamps strictly increase (ffprobe) and decoding in `-fps_mode vfr` is error free. The message is not suppressed: the property it was meant to protect is asserted directly. Not done: re-timing frames onto a constant grid (it would move video relative to audio).

## ADR-032: Toolbar and overlay: measure, do not guess; do not trust input before the window is shown (phase 08)

The toolbar window width is the measured width of its content (ResizeObserver -> `toolbar:resize`), replacing a computed table that clipped the mic-only layout. The selection overlay ignores pointer events until main has shown it (`overlay:ready` answered) and keeps gesture state in refs. Together with a cancelled capture not re-showing a window that was hidden in the tray, this makes the shortcut-driven flow predictable.

## ADR-033: The production UI is served from `app://framecapt`, not `file://` (phase 10, closes R-02)

- **Context.** With `GrantFileProtocolExtraPrivileges` off a `file://` page does not load in Electron 44 (tested in phase 09), so the fuse stayed on and gave file pages extra privileges.
- **Decision.** Register `app` as a privileged scheme (`standard`, `secure`) before `ready`; `protocol.handle('app', ...)` serves only the built renderer directory. `resolveAppAsset` (pure, unit-tested) accepts only `app://framecapt`, inspects the path as written (so a `..` that the URL parser would silently fold is still refused), decodes twice, refuses backslashes, NUL, `:`, empty and dot segments, requires a known extension (html, js, mjs, css, woff2, woff, png, svg, ico, json) and re-checks containment after `path.resolve`. Responses carry the MIME type, the production CSP, `nosniff` and `no-store`. Unknown or refused requests get a 404/400 without reading the disk. The scheme has no fetch API, CORS or CSP-bypass privilege. The dev server path is unchanged.
- **Consequences.** `isAppUrl` is origin-based (`app://framecapt`); CSP `'self'` now means that origin; the fuse is off in `forge.config.ts` and read back from the packaged and the installed exe. `registerSchemesAsPrivileged` may be called once, so both schemes are registered by `registerPrivilegedSchemes()`.
- **Alternatives rejected.** Keeping the fuse on and documenting it (the residual risk the review asked to remove); `net.fetch(file://)` inside the handler (needless: the files are read with `fs`, which Electron makes asar-aware).

## ADR-034: Squirrel.Windows installer, optional environment-only signing, no network at install (phase 10)

- **Decision.** `maker-squirrel` with a per-user install and `noMsi`; `maker-zip` as the portable build. Setup file `FrameCapt-Setup-<version>.exe`. Identity strings are marked PROVISIONAL in `forge.config.ts`. Signing: `WINDOWS_CERTIFICATE_FILE` + `WINDOWS_CERTIFICATE_PASSWORD` (and optionally `WINDOWS_TIMESTAMP_SERVER`) enable `windowsSign` for both the packaged binaries and the Squirrel installer; half-configured is a hard error; absent means the build log prints "UNSIGNED". No certificate is ever committed. The signing path itself was NOT run (no certificate on this host).
- **Measured defect fixed.** electron-winstaller's default nuspec carries an `<iconUrl>` that Squirrel downloads at install time (from raw.githubusercontent.com): on this host the silent install waited about 85 s for a connection timeout (5.9 s once fixed). An offline app should not make a request while installing, so `assets/app/framecapt.nuspectemplate` drops it. Cost: a generic icon in Programs and Features until the owner hosts an https icon URL.
- **User data on uninstall (revised, owner decision).** Squirrel removes only `%LOCALAPPDATA%\FrameCapt`. The `--squirrel-uninstall` hook removes the shortcuts and the launch-at-login entry and then asks once, "Remove your FrameCapt data too?" (buttons Keep my data / Remove, default Keep, no answer within 8 s means Keep). Remove deletes `%APPDATA%\FrameCapt` (history, settings, editable projects, recording sessions, logs). An unchecked-by-default box, "Also move my screenshots and recordings to the Recycle Bin", moves captures with `shell.trashItem` (never a permanent delete): a default folder (`Pictures\FrameCapt`, `Videos\FrameCapt`) as a whole only when everything in it is FrameCapt's own (capture-named files, its temp leftovers, `desktop.ini`); otherwise, and for custom output folders, only the media files that history lists. Links and junctions are never followed. The question is skipped (data kept) when `FRAMECAPT_UNINSTALL_KEEP=1` (used by `smoke:installed`), when FrameCapt is still running (its `lockfile` cannot be deleted), or when there is no data folder. To free the real folder from Chromium's lock the hook points `userData`, `sessionData` and `crashDumps` at a scratch folder first. Squirrel allows the hook about 15 s: the dialog times out at 8 s, trashing stops at 12.5 s and the process exits at 13 s. The portable zip and Linux are unchanged (no uninstaller; packages keep user data). Keeping the default means a reinstall continues where it left off, and a fresh start rescans the capture folders (history:rescan) so old captures reappear.
- **Known Squirrel residue.** `Update.exe --uninstall` leaves its own stub (`Update.exe`, a `.dead` marker and `app-<version>\squirrel.exe`, about 3.8 MB) in the install folder and an empty publisher folder in the Start Menu; none of FrameCapt's files remain. This is Squirrel.Windows behavior (the running updater cannot delete itself), documented in docs/packaging.md.

- **Found by running the installed app.** (1) `--squirrel-firstrun` was handled as a quit-early hook; it now starts the app normally. (2) Launch at login: the Electron docs' Squirrel form (`args: ['--processStart', '"FrameCapt.exe"', '--process-start-args', '"--hidden"']`) is escaped by Electron 44 when it writes the Run value, so Update.exe was asked to start a file called `"FrameCapt.exe"` (with quotes) and nothing started; plain arguments work and are used. (3) The uninstall hook now removes the launch-at-login entry (a registry write needs a ready app, so it runs after `ready`; Electron names the value after the AppUserModelID, `com.squirrel.FrameCapt.FrameCapt`). (4) The AppUserModelID of a Squirrel install is `com.squirrel.FrameCapt.FrameCapt`, so toast notifications match the Start Menu shortcut (verified with `Get-StartApps`).

## ADR-035: Update adapter: unconfigured by default, no autoUpdater, no request (phase 10)

- **Decision.** `UpdateService` wraps Electron's built-in `autoUpdater` (Squirrel.Windows feed). The feed URL is the build-time constant `__FRAMECAPT_UPDATE_URL__` (vite define from `FRAMECAPT_UPDATE_URL`, empty by default). Empty: state `unconfigured`, `autoUpdater` is never loaded, `setFeedURL`/`checkForUpdates` are never called, no network request. A non-https URL is an error state. Configured: `checkNow()` (the only entry point, not wired to any UI yet) sets the feed once and maps the autoUpdater events to the states. Feeds that would work: a static directory with `RELEASES` + `.nupkg` files, or `update.electronjs.org` for a public GitHub repository; neither is configured. Updates need a signed build in practice (owner action).
- **Verification.** A unit test asserts that an unconfigured service never touches the updater, and a source scan that only `updates.ts` calls its API. A 60 s e2e run and a 60 s installed run record zero non-loopback TCP connections and zero requests (docs/packaging.md, "Network behavior").

## ADR-036: Evidence files are only rewritten on request (phase 10)

Every e2e/native run used to rewrite the committed screenshots and JSON of earlier phases. `evidenceDirFor()` (tests/native/evidence.ts) now points at a scratch directory under the OS temp folder unless `FRAMECAPT_WRITE_EVIDENCE=1`; the tests still write and assert on their evidence. See docs/testing.md.

## ADR-037: Boot screen rendered by React for the main role only; Squirrel loadingGif; generated brand assets (brand pass, 2026-10-03)

- **Decision.** The start-up screen is a React component (`BootScreen`) shown by `MainApp`, the root of the main role, over an already mounted, inert `App`. It is not static markup in `index.html`.
- **Why.** One `index.html` serves every window role. A static loader there would flash in the transparent overlays and the instant toolbar, and the CSP forbids the inline script that could hide it per role. React already knows the role before it renders. Mounting `App` underneath lets its own settings, history and shortcut loads run in parallel, so there is no artificial delay (minimum display time 0): the screen is visible exactly as long as the first data takes. `ready-to-show` is independent of the data, so the window appears on the boot screen's first paint instead of after loading. A 6 s cap protects against a load that never answers.
- **Installer animation.** `loadingGif` (`assets/app/install-loading.gif`, 400x300, generated deterministically with the canvas GIF encoder) is wired into the Squirrel maker. electron-winstaller's own default is 268x167; Squirrel's window follows the image size, which has not been looked at on screen because silent installs show nothing (OWNER/lead: one interactive install to confirm).
- **Brand assets are generated and committed.** From one owner artwork, one script, deterministic output (hash-checked); builds do not run it. The alpha halo of the supplied artwork is repaired by a silhouette mask rather than edited by hand, so a new artwork version is a file swap and `npm run brand:assets`.
- **Not done / rejected.** A favicon (Electron windows show none; no `<link rel="icon">` was present). Per-theme logo variants (the artwork reads on light and dark). A progress percentage on the boot screen (the loads have no meaningful total).

## ADR-038: Experimental Linux x64 build: X11 forced, microphone only (2026-10-03)

- **Decision.** Linux x64 is built as an experimental `.deb` + AppImage (Forge makers, pinned Linux FFmpeg, pinned AppImage runtime). The app forces `--ozone-platform=x11` before `ready`; on Wayland sessions it runs through XWayland. System audio is not offered on Linux: `platformCapabilities()` (src/shared/platform.ts) reports it unavailable, the UI disables the switch with "Not available on Linux yet", and the capture authorization and the recorder controller both drop a system-audio request. Microphone capture is unchanged (PulseAudio/PipeWire through Chromium).
- **Why X11.** Under Wayland, Electron's `desktopCapturer` and `getDisplayMedia` go through the xdg-desktop-portal picker (PipeWire), which replaces FrameCapt's main-owned source selection and one-shot grants; global shortcuts are also limited there. XWayland keeps the same capture model as on Windows. Cost: native Wayland windows may be missing or black in a capture. Measured: on WSLg (XWayland over a Wayland compositor) a screenshot has the exact display size but black content; on a real X server (Xvfb) the pixels are right.
- **Why no system audio.** Chromium's `audio: 'loopback'` is Windows-only. A PulseAudio/PipeWire monitor source could be captured as a microphone-style device later; until it is built and tested the capability is reported off, never a silent track.
- **Toolbar.** `setContentProtection` is a no-op on Linux, so the recording toolbar may appear in full-screen and window recordings. Documented in the UI (one line) and docs; no compositor-specific workaround.
- **Launch at login** is an XDG autostart entry (`~/.config/autostart/framecapt.desktop`, `Exec=... --hidden`) written and removed by the same Settings switch.
- **Packaging choices.** The FFmpeg folder is copied by a `packageAfterCopy` hook for the target platform only. The AppImage maker is `@reforged/maker-appimage` (ISC; typed for maker-base 6/7, runs under Forge 8, cast in `forge.config.ts`); its runtime download is replaced by a SHA-256-pinned file. Executable name and package name are lower case `framecapt` on Linux.
- **Not done.** arm64, rpm, Flatpak/Snap, signing, system audio, Wayland-native capture, platform-specific UI wording.

## ADR-039: Desktop only; no accounts, login or website (2026-10-06)

- **Decision (owner).** The repository is the desktop app only. The account system (sign-in, organizations and workspaces, SSO, offline grants, device keys), the backend API and the website are removed from this branch; the app works as the 0.1.0-alpha.3 builds did, with no sign-in, plus the later desktop features.
- **Why.** A local, offline screenshot and recording tool needs no identity; the account layer added a service dependency, a locked state and a privacy trade-off that the product does not need.
- **Consequence.** No channel is gated by an authorization; history is a single local history; the app makes no network requests of its own. The removed work is preserved on the branch `login-website`.
