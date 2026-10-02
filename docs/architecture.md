# Framelet architecture

Status legend: **Implemented** = in the repository and exercised by tests; **Planned** = designed, not yet built.

## Processes

| Process  | Code                   | Responsibility                                                                                                                                                                                                                                            | Status                                                                                                                         |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Main     | `src/main/`            | Lifecycle, windows and their roles, security policy (CSP, navigation, permissions), IPC handlers, logging, source discovery and capture authorization (`src/main/capture/`), diagnostics file storage, later: tray, shortcuts, session filesystem, FFmpeg | Implemented (lifecycle, windows, security, IPC, logger, CaptureProvider, authorization, diagnostics storage); the rest Planned |
| Preload  | `src/preload/index.ts` | The only bridge: `window.framelet.invoke` / `on`, restricted to the shared contract                                                                                                                                                                       | Implemented                                                                                                                    |
| Renderer | `src/renderer/`        | Product UI, browser media pipeline (`src/renderer/capture/`), later editor and preview                                                                                                                                                                    | Implemented (shell, placeholders, error boundary, capture library prototypes, Capture diagnostics in Settings)                 |
| Shared   | `src/shared/`          | IPC contract (zod schemas, channel map, result types), CSP strings, role type. Bundled into main and preload by Vite                                                                                                                                      | Implemented                                                                                                                    |

The renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. There is no remote content: every window shows the bundled UI only.

## Build layout (Electron Forge + Vite)

`forge.config.ts` registers `@electron-forge/plugin-vite` with three builds:

- main: `src/main/index.ts` -> `.vite/build/main.cjs`
- preload: `src/preload/index.ts` -> `.vite/build/preload.cjs`
- renderer `main_window`: `src/renderer/index.html` -> `.vite/renderer/main_window/`

`package.json#main` is `.vite/build/main.cjs`. When `MAIN_WINDOW_VITE_DEV_SERVER_URL` is defined (`npm start`) the window loads the Vite dev server; otherwise (packaged build, `electron-forge package` output used by e2e) it loads `index.html` over `file://`.

## Window roles

One renderer entry (`main_window`) serves every window. The role is chosen by location hash and resolved in `src/renderer/main.tsx` (`role.ts`):

| Hash         | Role                                                                            | Status                                                                        |
| ------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `#/`         | `main`                                                                          | Implemented                                                                   |
| `#/overlay`  | `overlay` (one frameless window per display: region selector or display picker) | Implemented (phase 03)                                                        |
| `#/toolbar`  | `toolbar` (floating recording toolbar)                                          | Planned                                                                       |
| `#/recorder` | `recorder` (hidden capture worker; will own the single recorder in phase 05)    | Implemented as the screenshot frame-grab worker (phase 03); recording Planned |

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

## Screenshot workflow (phase 03: Implemented, verified on the host)

```
Home (main window)                     main process                              hidden worker ('recorder')   overlays ('overlay', one per display)
 Screen / Window / Region  --start-->  CaptureFlow.start  (BUSY if a flow runs)
                                       hide main window, wait 'hide' + 200 ms
                                       region:  worker:grabFrames  ----------->  grant + getDisplayMedia + one
                                                (every display)                  full-resolution PNG per source,
                                       <---------- worker:frameResult ---------  tracks released at once
                                       open one overlay per display (frozen frame, or picker) ---------------> overlay:getInit, overlay:ready
                                       <---------- overlay:confirm / pickDisplay / cancel -------------------- user selects
                                       crop frozen frame (nativeImage, pixels) or grab the picked display
                                       write userData/shots/<id>/original.png, close ALL overlays
 shot:ready -> result view   <------   show + focus main window, shot:ready, capture:flowEnded
```

- **Capture worker** (`windows.ts#getWorkerWindow`, `worker.ts`, `views/RecorderWorker.tsx`): one hidden `BrowserWindow` (role `recorder`, `show: false`, `backgroundThrottling: false`, the same secure web preferences), created on first use and destroyed when the main window closes. Main sends the event `worker:grabFrames { requestId, sources }`; the worker acquires each source in turn through the existing `capture:grant` + `getDisplayMedia` path (`acquireDisplayStream`, no audio), grabs one frame with `grabFullResolutionFrame`, stops the tracks, and answers with the invoke `worker:frameResult { requestId, frames[{ sourceId, width, height, png }] }` or `worker:frameError`. Main validates sizes (PNG <= 150 MB, dimensions <= 16384), accepts only the sources it asked for, and times a request out after 10 s. Only role `recorder` may call `worker:*`. `getDisplayMedia` needs no user gesture in a hidden window on Electron 44 (checked: it succeeds from `executeJavaScript` with and without the gesture flag).
- **Shot sessions** (`shots/session-store.ts`): `ShotSession { id (uuid), kind, width, height, createdAt, originalPath }`. The original PNG lives in app-owned `userData/shots/<id>/original.png`, never in a user folder and never memory-only. `discard` deletes only that directory (the id must match the uuid pattern and the resolved path must be inside the shots root). At startup, session directories older than 7 days without a `keep` marker are removed; only counts are logged. The renderer sees metadata and bytes through `shot:get`, never the path. Originals of sessions that are neither discarded nor swept stay on disk until the sweep (documented in ADR-014).
- **Overlays** (`overlay.ts`, `views/overlay/`): one frameless, always-on-top (`'screen-saver'` level), non-resizable, non-movable, no-shadow, `skipTaskbar` window per display, `bounds = display.bounds` and set again after creation (Electron's mixed-DPI placement quirk), then read back with `getBounds` (a mismatch is logged); `setContentProtection(true)` as a second line of defence. The first overlay to paint takes keyboard focus; if all overlays lose focus the flow is cancelled. Region mode shows the frozen frame full-bleed on an opaque window; pick-display mode uses a transparent window with a highlight and a "Click to capture this screen" card.
- **Region mode** is freeze-frame: the main window is hidden and the worker grabs every display BEFORE any overlay exists, so nothing of the selection UI can be in the pixels. The selection (local DIP) is mapped to frame pixels by `overlayRectToFramePixels` using the ACTUAL frame size ratio (`src/shared/geometry.ts`), rounded outward and clamped; selections under 2x2 px are refused. The crop uses `nativeImage.createFromBuffer(png, { scaleFactor: 1 }).crop(pixelRect)`. Dragging on another display clears the first display's selection (`overlay:selectionStarted` -> `overlay:clearSelection`). The pointer is clamped to the overlay's display, so a selection cannot leave it ("Selections stay on one screen").
- **Pick-display mode** (Screenshot > Screen with more than one display): overlays are closed, the screen settles for 200 ms, then the picked display is grabbed. With exactly one display no overlay is shown and the screen is captured at once.
- **Window mode**: the renderer shows a source picker dialog (`components/SourcePicker.tsx`, native `<dialog>`), main hides the main window and the worker grabs that window source. A 0-size or entirely black frame, a failed grab, or a window that vanished between listing and capture ends with "That window is minimized or can't be captured. Restore it and try again."
- **Flow state** (`shots/flow-state.ts`, `capture-flow.ts`): a second `capture:startScreenshot` while a flow runs fails with `BUSY`. Every path ends in exactly one `finish`: close all overlays and frozen frames, restore and focus the main window, then emit `shot:ready` (on success) and `capture:flowEnded { outcome: 'cancelled' | 'completed' | 'error' }`. Display changes while overlays are open (`display-added`, `display-removed`, `display-metrics-changed`) cancel with `DISPLAYS_CHANGED`. The renderer refocuses the button that started the flow when the flow ends without a result.
- **Export** (`shot-handlers.ts`): `shot:export` validates PNG/JPEG magic bytes and a 200 MB cap, shows `dialog.showSaveDialog` (parent: main window; default folder `Pictures/Framelet`, default name `Framelet YYYY-MM-DD at HH.mm.ss.png|jpg`) and writes atomically (temp file in the same folder, then rename). `shot:copy` validates PNG bytes and writes the image with the Electron 44 promise-based `clipboard.write([new ClipboardItem({ 'image/png': blob })])` (there is no `clipboard.writeImage` in this version). `shell:showItemInFolder` accepts only paths exported by Framelet in this run. The renderer encodes JPEG on a canvas (quality 0.92); the phase-04 editor will hand over flattened bytes through the same channels.

Channels added in phase 03 (main window): `capture:startScreenshot`, `shot:get`, `shot:export`, `shot:copy`, `shot:discard`, `shell:showItemInFolder`. Overlay role: `overlay:getInit`, `overlay:ready`, `overlay:selectionStarted`, `overlay:confirm`, `overlay:cancel`, `overlay:pickDisplay`. Recorder role: `worker:ready`, `worker:frameResult`, `worker:frameError`. Events: `shot:ready`, `capture:flowEnded`, `overlay:clearSelection`, `worker:grabFrames`.

Geometry that could not be exercised physically on the build host (both displays scale 1, primary at 0,0): mixed DPI, negative origins, rotation. These are covered by unit tests (`tests/unit/geometry.test.ts`: scales 1/1.25/1.5/2, a display at (-1920,-300), mixed-DPI pair, 90/270 rotation, frame size different from bounds x scale) and by the E2E mock build, whose two displays have scales 1 and 1.5, a negative origin and a frame size (3440) that is not bounds x scale (2293 x 1.5).

## Planned capture pipeline (Planned, phases 05+)

- **Source discovery**: implemented in phase 02 (see above).
- **Authorization**: implemented in phase 02 (see above).
- **Screenshots**: implemented in phase 03 (see above).
- **Recording**: a hidden `recorder` window owns a single recorder (MediaRecorder; WebM chosen after runtime `isTypeSupported` checks). Audio (microphone and system audio) is mixed in an explicit Web Audio graph into one track.
- **Persistence**: disk-backed WebM sessions. The renderer sends sequenced, size-capped chunks over IPC with acknowledgements and a bounded queue; main appends to a session file and keeps a manifest. Session ids and sequence numbers are validated at the IPC boundary. Finalization runs an FFmpeg remux so the output is a clean playable file (chunks are never concatenated blindly). Recovery after a crash is best effort.
- **Floating toolbar**: an always-on-top `toolbar` window using `setContentProtection(true)` so it is excluded from capture where Windows supports it (stated as a platform behavior, not a universal guarantee).
- **FFmpeg**: a controlled local child process (`shell: false`, argument array) for remux and MP4 conversion. Never a long-running server.
- **CaptureProvider**: a small interface so a native backend can be added later without speculative plugin infrastructure.
