# Framelet architecture

Status legend: **Implemented** = in the repository and exercised by tests; **Planned** = designed, not yet built.

## Processes

| Process  | Code                   | Responsibility                                                                                                                                                                                                                                            | Status                                                                                                                            |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Main     | `src/main/`            | Lifecycle, windows and their roles, security policy (CSP, navigation, permissions), IPC handlers, logging, source discovery and capture authorization (`src/main/capture/`), diagnostics file storage, later: tray, shortcuts, session filesystem, FFmpeg | Implemented (lifecycle, windows, security, IPC, logger, CaptureProvider, authorization, diagnostics storage); the rest Planned    |
| Preload  | `src/preload/index.ts` | The only bridge: `window.framelet.invoke` / `on`, restricted to the shared contract                                                                                                                                                                       | Implemented                                                                                                                       |
| Renderer | `src/renderer/`        | Product UI, browser media pipeline (`src/renderer/capture/`), screenshot editor (`src/renderer/editor/`, `views/editor/`), later preview                                                                                                                  | Implemented (shell, placeholders, error boundary, capture library prototypes, Capture diagnostics in Settings, screenshot editor) |
| Shared   | `src/shared/`          | IPC contract (zod schemas, channel map, result types), CSP strings, role type. Bundled into main and preload by Vite                                                                                                                                      | Implemented                                                                                                                       |

The renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. There is no remote content: every window shows the bundled UI only.

## Build layout (Electron Forge + Vite)

`forge.config.ts` registers `@electron-forge/plugin-vite` with three builds:

- main: `src/main/index.ts` -> `.vite/build/main.cjs`
- preload: `src/preload/index.ts` -> `.vite/build/preload.cjs`
- renderer `main_window`: `src/renderer/index.html` -> `.vite/renderer/main_window/`

`package.json#main` is `.vite/build/main.cjs`. When `MAIN_WINDOW_VITE_DEV_SERVER_URL` is defined (`npm start`) the window loads the Vite dev server; otherwise (packaged build, `electron-forge package` output used by e2e) it loads `index.html` over `file://`.

## Window roles

One renderer entry (`main_window`) serves every window. The role is chosen by location hash and resolved in `src/renderer/main.tsx` (`role.ts`):

| Hash          | Role                                                                            | Status                                                 |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `#/`          | `main`                                                                          | Implemented                                            |
| `#/overlay`   | `overlay` (one frameless window per display: region selector or display picker) | Implemented (phase 03)                                 |
| `#/toolbar`   | `toolbar` (floating recording toolbar)                                          | Implemented (phase 05)                                 |
| `#/recorder`  | `recorder` (hidden capture worker; screenshot frame grabs and the ONE recorder) | Implemented (phase 03 frame grabs, phase 05 recording) |
| `#/countdown` | `countdown` (click-through 3-2-1 window on the recorded display)                | Implemented (phase 05)                                 |

Unknown hashes render the main app. In main, `windows.ts` keeps `Map<webContents.id, Role>`; entries are removed on `destroyed`. Every IPC call is authorized against this registry.

## Preload and IPC model (Implemented)

`src/shared/ipc-contract.ts` is a single object map: `channel -> { request (zod), response (zod), roles }`. Types for `invoke` are derived from it. Phase-01 channels:

| Channel           | Request                                                          | Response                                                          | Roles |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ----- |
| `app:getInfo`     | none                                                             | `{ version, electron, chrome, node, platform, arch, isPackaged }` | main  |
| `app:reportError` | `{ source, message<=2000, stack<=8000?, componentStack<=8000? }` | void                                                              | all   |

Events (main -> renderer) are a separate allowlist (`app:themeChanged`).

Call path for `window.framelet.invoke(channel, payload)`:

1. Preload: rejects anything not in the contract (`UNKNOWN_CHANNEL`, using `Object.hasOwn`), then `ipcRenderer.invoke`.
2. Main `ipc.ts#handle(channel, { roles }, handler)`:
   1. `event.sender` must be a registered webContents whose role is allowed for the channel;
   2. `event.senderFrame` must be the top frame and its URL must be the app origin (dev: the Vite dev server origin; production: a file inside the built renderer directory);
   3. the payload is parsed with the channel's zod schema;
   4. the handler result is wrapped as `{ ok: true, data } | { ok: false, error: { code, message } }`. Unexpected errors are logged in main and replaced by a generic message, so raw errors never reach the renderer.
3. The pure parts (`app-origin.ts`, `ipc-core.ts`) have no Electron imports and are unit tested.

`handle` also refuses, at startup, to register a handler whose roles are broader than the contract's.

The preload never exposes `ipcRenderer`, Node APIs or arbitrary channels. Sandboxed preloads can only require a small `electron` subset, so shared code (the contract, including zod) is bundled into `preload.cjs` by Vite.

## Security model

| Control                                                       | Where                                                                                                                                                                               | Status                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| contextIsolation / sandbox / no nodeIntegration / webSecurity | `windows.ts`                                                                                                                                                                        | Implemented, e2e checks `window.require`/`window.process` are undefined    |
| CSP                                                           | Header via `session.webRequest.onHeadersReceived` (`security.ts`) and, in production builds, a `<meta http-equiv>` injected by a Vite plugin                                        | Implemented. e2e checks an injected inline script does not run             |
| Navigation lockdown                                           | `will-navigate`, `will-redirect` blocked unless app origin; `setWindowOpenHandler` denies all; `will-attach-webview` prevented                                                      | Implemented, e2e checks a foreign navigation and `window.open` are blocked |
| Permissions                                                   | `setPermissionRequestHandler` / `setPermissionCheckHandler`: only `media` and `clipboard-sanitized-write`, only for app URLs                                                        | Implemented (unit tested)                                                  |
| Single instance                                               | `app.requestSingleInstanceLock()`, second launch focuses the existing window                                                                                                        | Implemented (not covered by an automated test)                             |
| Electron fuses                                                | `@electron-forge/plugin-fuses`: RunAsNode off, cookie encryption on, NODE_OPTIONS and `--inspect` off, embedded ASAR integrity on, only load from ASAR                              | Implemented; verified by launching the packaged exe                        |
| Logging                                                       | `userData/logs/main.log`, 2 MB rotation (one old file), never logs capture content                                                                                                  | Implemented (unit tested)                                                  |
| Test hooks                                                    | `FRAMELET_USER_DATA_DIR` (also relocates the Pictures folder) is honored only when `!app.isPackaged`; `FRAMELET_E2E_MOCK_CAPTURE` / `FRAMELET_E2E_MOCK_DISPLAYS` only in E2E builds | Implemented                                                                |

CSP note: in Electron 44 on Windows, `onHeadersReceived` was observed to fire for `file://` requests (checked with a temporary log line). The `<meta>` tag is kept as a second layer so production does not depend on that behavior. The `<meta>` variant omits `frame-ancestors`, which is not supported there.

## Capture (phase 02 prototype: Implemented and verified on the host; product flows are Planned)

Measured results and the API details are in [capture-feasibility.md](capture-feasibility.md).

| Part                                                                                                                                  | Code                                                                          | Status                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `CaptureProvider` interface (`listDisplays`, `listSources`)                                                                           | `src/main/capture/types.ts`                                                   | Implemented                                                        |
| Electron provider over `screen` + `desktopCapturer`; excludes Framelet's own windows                                                  | `src/main/capture/electron-provider.ts`                                       | Implemented, verified on the host                                  |
| Mock provider for UI tests; reachable only in builds made with `FRAMELET_E2E_BUILD=1` and a runtime env flag                          | `src/main/capture/mock-provider.ts`, `index.ts`, `scripts/check-no-mocks.mjs` | Implemented; `npm run check:mocks` proves a normal bundle has none |
| Authorization: `setDisplayMediaRequestHandler` answering only from one-shot, 5 s, webContents-bound grants created by `capture:grant` | `src/main/capture/authorization.ts`, `grants.ts`                              | Implemented, verified (denial paths, one-shot)                     |
| Renderer library: `stream.ts`, `frame.ts`, `audio-graph.ts`, `region-crop.ts`, `recorder-probe.ts`, `resource-registry.ts`            | `src/renderer/capture/`                                                       | Implemented as prototypes, verified on the host                    |
| Diagnostics view (Settings) and main-owned `userData/diagnostics/` storage                                                            | `src/renderer/views/diagnostics/`, `src/main/capture/diagnostics.ts`          | Implemented. Whole-blob saving is for this bounded prototype only  |
| Toolbar, recording, disk-backed recording sessions, FFmpeg                                                                            |                                                                               | Planned                                                            |

Channels added: `capture:listDisplays`, `capture:listSources` (main), `capture:grant` (main, recorder), `diagnostics:saveRecording`, `diagnostics:revealFolder` (main). The permission handler now denies `media` requests that include video (camera).

## Screenshot workflow (phase 03, capture source revised in phase 04: Implemented, verified on the host)

```
Home (main window)                     main process                              overlays ('overlay', one per display)      hidden worker ('recorder', fallback only)
 Screen / Window / Region  --start-->  CaptureFlow.start  (BUSY if a flow runs)
                                       region / pick-display: create the overlay windows HIDDEN (opacity 0) now,
                                         their renderers load while the next steps run -> overlay:getInit waits
                                       hide main window, wait 'hide' + 200 ms
                                       region:  desktopCapturer.getSources({ thumbnailSize: max physical size })
                                                one call, every display, size verified == physical size
                                                (a display that fails: worker:grabFrames ---------------------------------------------> getDisplayMedia frame)
                                       overlays.setFrames -> showInactive at opacity 0 -> raw BGRA frame ----> paint on a canvas,
                                                                                                    overlay:ready -> opacity 1 + focus
                                       <---------- overlay:confirm / pickDisplay / cancel -------------------- user selects
                                       crop the frozen NativeImage (pixels) or grab the picked display
                                       write userData/shots/<id>/original.png, close ALL overlays
 shot:ready -> editor   <----------   show + focus main window, shot:ready, capture:flowEnded
```

- **Pixel-exact capture source (phase 04, ADR-014)**: screen and region screenshots come from `desktopCapturer` images in MAIN (`capture/exact-capture.ts`), not from `getDisplayMedia` video frames (4:2:0: about one pixel of chroma bleed on saturated edges, measured in phase 03). ONE `getSources({ types: ['screen'], thumbnailSize: { width: max physical width, height: max physical height }, fetchWindowIcons: false })` call serves all displays (Electron fits each thumbnail into the box keeping its aspect, so asking for the largest dimensions means nothing is downscaled); sources are mapped to displays by `display_id`, and an image is accepted only when `getSize()` equals the display's physical size EXACTLY. Otherwise that display falls back to the worker's `getDisplayMedia` frame and a warning is logged. Window screenshots first take the worker's video frame to learn the window's size, then request a window thumbnail at exactly that size; when the size matches the thumbnail is used (pixel-exact), otherwise the video frame is kept. The path that ran is logged (`Screenshot path: ...`, `Freeze-frame: n/n screens exact`). `getDisplayMedia` stays the capture method for recording. The E2E mock build skips this path (synthetic frames come from the worker).
- **Capture worker** (`windows.ts#getWorkerWindow`, `worker.ts`, `views/RecorderWorker.tsx`): one hidden `BrowserWindow` (role `recorder`, `show: false`, `backgroundThrottling: false`, the same secure web preferences), created on first use and destroyed when the main window closes. Since phase 04 it is the FALLBACK for screenshots (a display whose exact image failed verification, the window size probe, the E2E synthetic frames) and will own recording in phase 05. Main sends the event `worker:grabFrames { requestId, sources }`; the worker acquires each source in turn through the existing `capture:grant` + `getDisplayMedia` path (`acquireDisplayStream`, no audio), grabs one frame with `grabFullResolutionFrame`, stops the tracks, and answers with the invoke `worker:frameResult { requestId, frames[{ sourceId, width, height, png }] }` or `worker:frameError`. Main validates sizes (PNG <= 150 MB, dimensions <= 16384), accepts only the sources it asked for, and times a request out after 10 s. Only role `recorder` may call `worker:*`.
- **Shot sessions** (`shots/session-store.ts`): `ShotSession { id (uuid), kind, width, height, createdAt, originalPath }`. The original PNG lives in app-owned `userData/shots/<id>/original.png`, never in a user folder and never memory-only. `discard` deletes only that directory (the id must match the uuid pattern and the resolved path must be inside the shots root); `discardSync` does the same while the app is closing. At startup, session directories older than 7 days without a `keep` marker are removed; only counts are logged. The renderer sees metadata and bytes through `shot:get`, never the path. **Lifecycle (phase 04)**: the session is created when the capture completes; the editor opens it with `shot:get` (main remembers it as the editor's session); it is deleted when the editor closes (Done, Discard, leaving the Capture tab, or closing the app window). A successful save or copy does NOT delete it, so the user can keep editing and save again. A crash leaves the directory for the 7-day sweep.
- **Overlays** (`overlay.ts`, `views/overlay/`): one frameless, always-on-top (`'screen-saver'` level), non-resizable, non-movable, no-shadow, `skipTaskbar` window per display, `bounds = display.bounds` and set again after creation (Electron's mixed-DPI placement quirk), then read back with `getBounds` (a mismatch is logged); `setContentProtection(true)` as a second line of defence. The first overlay to paint takes keyboard focus; if all overlays lose focus the flow is cancelled. Region mode shows the frozen frame full-bleed on an opaque window; pick-display mode uses a transparent window with a highlight and a "Click to capture this screen" card. **Phase 04 latency work**: the windows are created hidden (opacity 0, never shown) at the start of the flow, so their renderers load while the main window hides and the screens are grabbed; they are shown (`showInactive()`, still at opacity 0) only AFTER the grab, because a never-shown window's renderer is throttled to about one frame per second (the "painted" signal, a double `requestAnimationFrame`, then took 1-2 s on some overlays); `overlay:ready` sets the opacity to 1. A never-shown window cannot be in a capture, so the "frames are grabbed before any overlay is visible" invariant holds. The frozen frame travels as raw BGRA bytes (`NativeImage.toBitmap()`, ~20 MB for 3440x1440) and is painted on a canvas (`shared/pixels.ts#bgraToRgba`); encoding it as PNG cost ~110 ms per screen in main plus a decode in each renderer.
- **Region mode** is freeze-frame: the main window is hidden and every display is grabbed BEFORE any overlay is visible, so nothing of the selection UI can be in the pixels. The selection (local DIP) is mapped to frame pixels by `overlayRectToFramePixels` using the ACTUAL frame size ratio (`src/shared/geometry.ts`), rounded outward and clamped; selections under 2x2 px are refused. The crop is `frozenNativeImage.crop(pixelRect)` (the frame is a `NativeImage` kept in main, scale factor 1). Dragging on another display clears the first display's selection (`overlay:selectionStarted` -> `overlay:clearSelection`). The pointer is clamped to the overlay's display, so a selection cannot leave it ("Selections stay on one screen").
- **Pick-display mode** (Screenshot > Screen with more than one display): overlays are closed, the screen settles for 200 ms, then the picked display is grabbed. With exactly one display no overlay is shown and the screen is captured at once.
- **Window mode**: the renderer shows a source picker dialog (`components/SourcePicker.tsx`, native `<dialog>`), main hides the main window and the worker grabs that window source. A 0-size or entirely black frame, a failed grab, or a window that vanished between listing and capture ends with "That window is minimized or can't be captured. Restore it and try again."
- **Flow state** (`shots/flow-state.ts`, `capture-flow.ts`): a second `capture:startScreenshot` while a flow runs fails with `BUSY`. Every path ends in exactly one `finish`: close all overlays and frozen frames, restore and focus the main window, then emit `shot:ready` (on success) and `capture:flowEnded { outcome: 'cancelled' | 'completed' | 'error' }`. Display changes while overlays are open (`display-added`, `display-removed`, `display-metrics-changed`) cancel with `DISPLAYS_CHANGED`. The renderer refocuses the button that started the flow when the flow ends without a result.
- **Export** (`shot-handlers.ts`): `shot:export` validates PNG/JPEG magic bytes and a 200 MB cap, shows `dialog.showSaveDialog` (parent: main window; default folder `Pictures/Framelet`, default name `Framelet YYYY-MM-DD at HH.mm.ss.png|jpg`) and writes atomically (temp file in the same folder, then rename). `shot:copy` validates PNG bytes and writes the image with the Electron 44 promise-based `clipboard.write([new ClipboardItem({ 'image/png': blob })])` (there is no `clipboard.writeImage` in this version). `shell:showItemInFolder` accepts only paths exported by Framelet in this run. Since phase 04 the renderer sends the FLATTENED bytes of the editor (below) through these channels; main never sees annotations and never reads the original for export.

Channels added in phase 03 (main window): `capture:startScreenshot`, `shot:get`, `shot:export`, `shot:copy`, `shot:discard`, `shell:showItemInFolder`. Overlay role: `overlay:getInit` (now waits for the frames), `overlay:ready`, `overlay:selectionStarted`, `overlay:confirm`, `overlay:cancel`, `overlay:pickDisplay`. Recorder role: `worker:ready`, `worker:frameResult`, `worker:frameError`. Events: `shot:ready`, `capture:flowEnded`, `overlay:clearSelection`, `worker:grabFrames`. Added in phase 04 (main window): `editor:setDirty { dirty }`, `editor:resolveClose { discard }`; event `app:confirmClose`. `OverlayInit.image` is now raw BGRA bytes (`imageFormat: 'bgra'`).

Geometry that could not be exercised physically on the build host (both displays scale 1, primary at 0,0): mixed DPI, negative origins, rotation. These are covered by unit tests (`tests/unit/geometry.test.ts`: scales 1/1.25/1.5/2, a display at (-1920,-300), mixed-DPI pair, 90/270 rotation, frame size different from bounds x scale) and by the E2E mock build, whose two displays have scales 1 and 1.5, a negative origin and a frame size (3440) that is not bounds x scale (2293 x 1.5).

## Screenshot editor (phase 04: Implemented; pixel checks verified on the host and in the E2E build)

The editor replaces the phase-03 result view and runs in the main window's renderer. It is an internal Canvas 2D implementation (ADR-015), no canvas framework.

| Part      | Code                                                                                                                                                 | Notes                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Model     | `src/renderer/editor/model/` (`types`, `commands`, `history`, `hit-test`, `geometry`, `arrow`)                                                       | Pure TypeScript, no DOM, unit tested. All geometry is in IMAGE PIXELS of the original capture.                               |
| Flatten   | `src/renderer/editor/flatten.ts` (pure, on a Canvas2D-like `DrawContext`), `export.ts` (OffscreenCanvas: `flattenToBlob`, `flattenThumbnail`, fonts) | The same `renderDoc` produces the export in Chromium and runs against Skia (`@napi-rs/canvas`) in the unit tests.            |
| View math | `src/renderer/editor/view.ts`                                                                                                                        | `screenToImage` is the single pointer conversion; unit tested for zoom/pan/DPR combinations.                                 |
| UI        | `src/renderer/views/editor/` (`EditorView` state and shortcuts, `EditorStage` canvas/pointer/text, `EditorToolbar`, `OptionsStrip`)                  | One visible canvas redrawn on demand; no animation loop while idle (e2e counts `requestAnimationFrame` calls while idle: 0). |

**Model.** `Annotation` = `arrow { from, to, color, width }` | `rect { rect, color, width }` | `text { at, text, color, fontSize, fontWeight }` | `redact { rect }`; `EditorDoc { width, height, annotations, crop: Rect | null }`. A redaction has NO color and NO opacity field; the reducer rebuilds it from its rectangle only and ignores any other patch field. `apply(doc, command)` is a pure reducer (`add`, `update`, `remove`, `setCrop`, `reorder`) that returns the SAME object for no-ops. `History { past, present, future, gesture }` holds immutable documents (structural sharing), at most 200 undo entries, and merges commands that carry the same gesture key into one entry (a drag, or a run of arrow-key nudges). Crop is non-destructive: `setCrop` stores an integer rectangle clamped to the image, annotations keep original coordinates, undo/redo restores it, and the editor dims everything outside the crop (the whole image stays visible and editable).

**View and DPR.** `View { zoom, panX, panY }`: `zoom` is DEVICE pixels per image pixel (1 = 100% = the capture 1:1 on the screen's pixels at any devicePixelRatio), pan is in CSS px. Zoom range 10%-800%, fit-to-view by default (never above 100%), Ctrl+wheel zooms at the cursor, Space/middle-drag pans. The canvas backing store is stage size x devicePixelRatio, so lines and handles stay crisp; nothing but the view transform knows about zoom or DPR.

**Flatten and redaction rules (ADR-016).**

1. `renderDoc(ctx, base, doc, { forExport: true })` draws the crop rectangle of the base image (`drawImage` source rect), then the annotations in z-order translated by -crop, then ALL redactions LAST: a redaction can never be undercut by a later arrow, rectangle or text ("Redactions always cover everything beneath", also shown as a tooltip).
2. A redaction is `#000000` at alpha 1, `source-over`, drawn with integer coordinates. Its rectangle is snapped outward to whole pixels and grown by one more pixel on every side, so no half-blended original pixel survives at an edge.
3. JPEG: compression smears a hard black edge across the 8x8 luma and 16x16 (4:2:0) chroma blocks it passes through. Measured on random noise at quality 0.92, black pixels deviated by up to 37 levels (up to 14 px from the edge); even quality 1.0 left 14 (chroma upsampling reaches across block borders). For JPEG the cover therefore grows to the 16 px block grid of the OUTPUT image plus a 2 px margin (`jpegRedactionCoverage`), so every block touching the user's rectangle is entirely black. Measured: every pixel under the drawn rectangle is 0 in a Chromium-encoded JPEG. The cost: JPEG redactions cover up to 17 px more per side than the PNG ones (the Save menu says so).
4. Export size = crop size or full image size; never scaled by zoom or devicePixelRatio. Text uses Inter (bundled; `document.fonts.load` runs before flattening) with a font size in image pixels, so the export matches the editor at any zoom.
5. Save and Copy send the flattened PNG/JPEG (JPEG quality 0.92) to `shot:export` / `shot:copy`. The original is retained only in the app-owned session directory for editing; an exported file is the redacted artifact and is never the original unless no edit changed anything. `flattenThumbnail(base, doc, maxWidth = 480)` renders the flattened output (crop and redactions applied) and is the ONLY thumbnail source the history view (phase 07) may use.

**Unsaved changes.** `dirty` = the document differs from the one last saved or copied (a fresh capture is dirty until its first save/copy; undoing back to the saved state is clean). Done, Discard, leaving the Capture tab and closing the window with a dirty editor ask "Discard this screenshot?" in a Radix AlertDialog (focus trapped, focus starts on "Keep editing"). Closing: the renderer reports `editor:setDirty`; main intercepts the window's `close` (`main/close-guard.ts`): clean -> close; dirty -> keep the window, send `app:confirmClose`, and the answer arrives as `editor:resolveClose { discard }`. A second close while the question is open always goes through (a hung renderer can never trap the user), `session-end` (logoff/shutdown) is never held up, and `app.exit()` bypasses it. No `beforeunload` is used. Keyboard shortcuts live in the editor view only and are ignored while typing in an input, textarea or open menu, or while a dialog is open.

**Accessibility.** The top bar is a `role="toolbar"` with a roving tabindex (arrow keys, Home/End), every control has an accessible name, tool and save/copy changes are announced in an `aria-live="polite"` region, focus rings are visible, and the options strip uses `radiogroup`/`radio` for colors, stroke and text size.

## Recording (phase 05: Implemented; native checks verified on the host, see capture-feasibility.md)

### Ownership

```
 main window / toolbar / (later tray, shortcuts)
        | recorder:start | pause | resume | stop | cancel | toggleMute | resolveChoice | reset
        v
 MAIN: RecorderController (src/main/recorder/controller.ts)  <- the ONE authoritative state
   pure machine (src/shared/recorder-machine.ts) -> recorder:state snapshot broadcast
        |  recorder:engineCommand (prepare | start | pause | resume | stop | abort | mute | levels)
        v                                           ^ recorder:engineEvent (prepared | needsChoice | started | stopped | sourceLost | trackEnded | levels | error)
 hidden 'recorder' window: RecorderEngine (src/renderer/recorder/engine.ts) - the only MediaRecorder
        | session:appendChunk {sessionId, seq, bytes}  (ack before the next)   | session:finish {sessionId, lastSeq}
        v
 MAIN: SessionService (src/main/recording/session-service.ts) -> userData/recordings/<id>/{manifest.json, stream.webm}
```

- **State is owned by main** and only broadcast: every window renders `recorder:state` snapshots (`status`, `activeMs` + `runningSince` for a live timer, `audio`, `muted`, `lost`, `choice`, `countdown`, `result`). Commands from any UI go through main, so a stop from the toolbar, the main window, closing the toolbar, a lost source and quitting the app are the same idempotent operation.
- **One recorder.** `RecorderEngine` asserts there is no other active MediaRecorder (`activeRecorderCount()`), commands run strictly in order, and every terminal path calls `releaseAll()`: tracks, audio context, level timer, crop timer and recorder are all released. `window.__frameletResources()` (read-only counters in the recorder window) lets the tests assert zero live tracks / audio contexts / loops / recorders after every recording.
- The recorder window is the phase-03 worker with `backgroundThrottling: false`. Measured: a hidden, never-shown window records at about 30 fps with this setting (see capture-feasibility.md).

### State machine

States: `idle -> selecting -> preflight -> countdown -> starting -> recording <-> paused -> stopping -> processing -> completed | error`. selecting, preflight, countdown and starting go back to `idle` on CANCEL or STOP. Events: START_REQUESTED, SOURCE_SELECTED, PREFLIGHT_OK, PREFLIGHT_NEEDS_CHOICE, COUNTDOWN_DONE, STARTED, PAUSE, RESUME, STOP, CANCEL, SOURCE_LOST, WRITE_FAILED, FINALIZED, FAILED, RESET, plus three extras: STOPPED (the engine flushed: stopping -> processing), MUTE_SET and AUDIO_LOST (a source's mute flag and "device gone" flag are part of the state). An event that is not valid in a state returns the same state with `rejected: true` and never throws; STOP in stopping, processing and completed is an accepted no-op. `activeDurationMs` is accumulated from monotonic timestamps of the running segments only, so paused time is never counted (wall clock is kept separately as `startedAt`). tests/unit/recorder-machine.test.ts checks every event in every state against a written-out table, plus the required scenarios (rapid start/stop, stop during countdown, cancel during starting, duplicate stop, pause/resume in the wrong state, source lost while paused, write failure while recording, reset after completed/error) and 200 random event sequences.

### Start-up flow

1. START: main minimizes the main window (a minimized window is not capturable; it stays in the taskbar so the user can find it).
2. selecting: a window comes from the picker; a screen is the only display, the `displayId` in the request, or the pick-display overlay; a region uses the overlay in `record-region` mode: **live**, not frozen (transparent window, 45% dim around the selection, the desktop keeps running underneath), button "Record" (Enter). The overlay is closed before anything is recorded, so it can never be in the output. The overlay IPC is routed to the recorder or the screenshot flow by `SelectionHost`. The region is mapped to display pixels with `overlayRectToFramePixels` and rounded down to even x, y, width, height.
3. preflight (`prepare` in the engine): enumerate microphones, acquire the display stream (with loopback if asked), acquire the microphone (`echoCancellation` and `noiseSuppression` on), build the canvas pipeline and the audio mix. Anything the user asked for that is not there is a **choice**, never silence: system audio without a loopback track ("System audio isn't available": record without it / cancel), a microphone id that is not in `enumerateDevices` (use the default microphone / record without a microphone / cancel), a denied microphone (record without / cancel), a microphone that cannot be opened. The main window is brought back for the question and minimized again after the answer.
4. countdown (optional 3-2-1): a transparent, click-through, content-protected, non-focusable window on the recorded display. Esc cancels through a global shortcut that is registered only while the countdown runs. Reduced motion is respected by the global `prefers-reduced-motion` rule. The window is closed (plus a 120 ms settle) before the recorder starts.
5. starting: the session directory is created, the engine starts the MediaRecorder (timeslice 1000 ms), the toolbar is shown.

### Video and audio pipeline

display stream -> canvas (`createCanvasTransform`: crop to the region and/or fit the 1080p preset, drawn from a self-correcting timer, so the frame rate is constant even on a static screen) -> `canvas.captureStream` video track. Quality presets: "1080p" fits inside 1920 x 1080 keeping the aspect ratio with even sides, never upscaling (3440 x 1440 -> 1920 x 804); "Source" keeps the native size. Frame rate 30 (default) or 60. Video bitrate 8 Mbps at 1080p30, scaled with pixels and frame rate (2.5-30 Mbps), Opus 128 kbps. Microphone and system audio each go through their own GainNode (mute = gain 0, not `track.enabled`), an AnalyserNode (levels) and into one MediaStreamAudioDestinationNode: one mixed track, nothing is ever connected to the speakers. Levels are sampled at 10 Hz only while recording and only while main says a toolbar is visible. A microphone or system track that ends, or a `devicechange` that removes the microphone, is reported once (`trackEnded`): the recording continues with the other sources, the toolbar shows a badge ("Microphone disconnected"), the main window shows a toast.

### Chunk protocol and session files

- Renderer: `ChunkUploader` numbers chunks from 0 when they are pushed, reads each Blob only when it is its turn, sends `session:appendChunk` and waits for the acknowledgement before sending the next (strictly serial, ordered). The queue is bounded at 16 chunks or 64 MB: a chunk that does not fit is not accepted, the uploader fails with `QUEUE_OVERFLOW`, the recorder stops, and the chunks accepted so far are still written. Nothing is dropped silently and nothing is buffered without bound. A failed write halts the uploader.
- Main (`SessionService`): validates the session (exists, still recording), size (1 byte to 16 MB, the IPC schema enforces the same cap), and sequence (exactly last + 1; the previous chunk again with the same length is acknowledged without a second write; a gap is `SEQ_GAP`; anything else `SEQ_CONFLICT`). It writes with a real `FileHandle.write` loop (partial writes handled) and acknowledges after the write. ENOSPC/EDQUOT map to `DISK_FULL`, everything else to `WRITE_FAILED`; the session is then closed, marked `failed` and `truncated` and kept. `manifest.json` (version, session id, state, MIME, source, options, size, chunks, bytes, last seq, paused intervals, timestamps) is rewritten atomically (temp file + rename) at most every 5 s or 10 chunks and at every state change; a failing manifest update never loses a chunk.
- Stop: the engine calls `recorder.stop()`, waits for the final `dataavailable` AND the acknowledgement of every chunk, then `session:finish {sessionId, lastSeq}`; main verifies `lastSeq`, fsyncs, closes and sets `state: "stopped"`. Publishing (`SessionService.publish`) copies `stream.webm` to `Videos/Framelet/Framelet YYYY-MM-DD at HH.mm.ss.webm` through a temp file and a rename (a number is added instead of overwriting), and the manifest becomes `completed` with `outputPath`. The session directory is kept (phase 06 decides about cleanup and adds recovery and FFmpeg remux).
- **Known limitation until phase 06:** the published file is the raw MediaRecorder WebM. It has no duration header and no seek cues. It plays and the result view finds its duration by seeking, and ffmpeg/ffprobe read it, but other players may show no duration or seek slowly. Phase 06 remuxes with FFmpeg.
- Failures while recording (queue overflow, disk full, recorder error) stop the recording, keep what was acknowledged and publish it with a notice ("The recording stopped early"). A source loss does the same without an error. A recording shorter than one video frame (a few milliseconds) has no data and ends in the error "too short to save".

### Windows and playback

- **Toolbar** (`toolbar` role, `#/toolbar`): a 48 DIP high frameless always-on-top pill, `skipTaskbar`, `setContentProtection(true)`, draggable by the grip only (`-webkit-app-region`), timer (active time, `h:mm:ss` after an hour), pause/resume, stop, per-source mute and meter, warning badge; paused shows an amber dot and "Paused"; stopping/processing show "Saving..." (or "Finishing recording..." while the app quits). Placement (`src/shared/toolbar-placement.ts`, unit tested): whole screen or window = bottom-center of the display's work area (above the taskbar), 24 DIP up; region = just below the region, else above, else on another display, and only as a last resort (single display, region fills it) inside it. Width follows the recorded audio sources and grows when a source is lost.
- **Main window during recording**: minimized (and a close request only minimizes it) and restored when the recording is over. The result view shows a player (`<video>` on `framelet-media://<id>`), duration / size / dimensions / audio badges, Show in folder, Copy path, New recording.
- **`framelet-media:`** (`src/main/recording/media-protocol.ts`): a privileged (standard, secure, stream, fetch) scheme registered before ready. It serves ONLY files main produced (an unguessable id -> path map) with Range support implemented from the file (`Content-Range`, 206, 416; parser unit tested), and `framelet-media:` is allowed in `media-src` only, in both CSPs.
- **Quit**: `before-quit` while recording or paused stops and finalizes first (toolbar: "Finishing recording..."), with a hard cap of 15 s, after which the session directory is simply left on disk for recovery (phase 06). Before recording started it is a cancel.

Channels added in phase 05: `recorder:start | pause | resume | stop | cancel | toggleMute | getState | resolveChoice | reset | showInFolder | copyPath` (main window; the toolbar may pause, resume, stop, cancel, mute and read state), `recorder:engineEvent`, `session:appendChunk`, `session:finish` (recorder window only). Events: `recorder:state`, `recorder:levels`, `recorder:engineCommand`. New role `countdown`. New IPC error codes: SEQ_GAP, SEQ_CONFLICT, CHUNK_TOO_LARGE, SESSION_INACTIVE, WRITE_FAILED, DISK_FULL.

## Planned capture pipeline (phase 06 onward)

- **Source discovery**: implemented in phase 02 (see above).
- **Authorization**: implemented in phase 02 (see above).
- **Screenshots**: implemented in phase 03 (see above).
- **Recording**: implemented in phase 05 (see "Recording" above).
- **Persistence**: the sequenced, acknowledged chunk protocol and a minimal correct disk sink are implemented (phase 05). Phase 06 adds disk-pressure checks, recovery of incomplete sessions on restart and the FFmpeg remux (chunks are never concatenated blindly).
- **Floating toolbar**: implemented in phase 05; exclusion from capture with `setContentProtection` was measured on the host (capture-feasibility.md).
- **FFmpeg**: a controlled local child process (`shell: false`, argument array) for remux and MP4 conversion. Never a long-running server.
- **CaptureProvider**: a small interface so a native backend can be added later without speculative plugin infrastructure.
