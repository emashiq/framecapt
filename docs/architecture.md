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

| Hash         | Role                                                     | Status                                                                         |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `#/`         | `main`                                                   | Implemented                                                                    |
| `#/overlay`  | `overlay` (region/source selection overlay)              | Planned. Hash dispatch exists; renders the main app until a view is registered |
| `#/toolbar`  | `toolbar` (floating recording toolbar)                   | Planned                                                                        |
| `#/recorder` | `recorder` (hidden window that owns the single recorder) | Planned                                                                        |

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

| Control                                                       | Where                                                                                                                                                  | Status                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| contextIsolation / sandbox / no nodeIntegration / webSecurity | `windows.ts`                                                                                                                                           | Implemented, e2e checks `window.require`/`window.process` are undefined    |
| CSP                                                           | Header via `session.webRequest.onHeadersReceived` (`security.ts`) and, in production builds, a `<meta http-equiv>` injected by a Vite plugin           | Implemented. e2e checks an injected inline script does not run             |
| Navigation lockdown                                           | `will-navigate`, `will-redirect` blocked unless app origin; `setWindowOpenHandler` denies all; `will-attach-webview` prevented                         | Implemented, e2e checks a foreign navigation and `window.open` are blocked |
| Permissions                                                   | `setPermissionRequestHandler` / `setPermissionCheckHandler`: only `media` and `clipboard-sanitized-write`, only for app URLs                           | Implemented (unit tested)                                                  |
| Single instance                                               | `app.requestSingleInstanceLock()`, second launch focuses the existing window                                                                           | Implemented (not covered by an automated test)                             |
| Electron fuses                                                | `@electron-forge/plugin-fuses`: RunAsNode off, cookie encryption on, NODE_OPTIONS and `--inspect` off, embedded ASAR integrity on, only load from ASAR | Implemented; verified by launching the packaged exe                        |
| Logging                                                       | `userData/logs/main.log`, 2 MB rotation (one old file), never logs capture content                                                                     | Implemented (unit tested)                                                  |
| Test hooks                                                    | `FRAMELET_USER_DATA_DIR` is honored only when `!app.isPackaged`                                                                                        | Implemented                                                                |

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
| Overlay, toolbar, recorder window, disk-backed sessions, FFmpeg                                                                       |                                                                               | Planned                                                            |

Channels added: `capture:listDisplays`, `capture:listSources` (main), `capture:grant` (main, recorder), `diagnostics:saveRecording`, `diagnostics:revealFolder` (main). The permission handler now denies `media` requests that include video (camera).

## Planned capture pipeline (Planned, phases 03+)

- **Source discovery**: implemented in phase 02 (see above).
- **Authorization**: implemented in phase 02 (see above).
- **Screenshots**: a freeze-frame of the chosen display (a live video frame at full resolution, never an upscaled thumbnail) is shown in an overlay window for region selection; the selection is cropped from that frame. Coordinates are mapped from display-independent units to pixels, accounting for negative monitor origins and scale factors. Region capture is limited to one monitor.
- **Recording**: a hidden `recorder` window owns a single recorder (MediaRecorder; WebM chosen after runtime `isTypeSupported` checks). Audio (microphone and system audio) is mixed in an explicit Web Audio graph into one track.
- **Persistence**: disk-backed WebM sessions. The renderer sends sequenced, size-capped chunks over IPC with acknowledgements and a bounded queue; main appends to a session file and keeps a manifest. Session ids and sequence numbers are validated at the IPC boundary. Finalization runs an FFmpeg remux so the output is a clean playable file (chunks are never concatenated blindly). Recovery after a crash is best effort.
- **Floating toolbar**: an always-on-top `toolbar` window using `setContentProtection(true)` so it is excluded from capture where Windows supports it (stated as a platform behavior, not a universal guarantee).
- **FFmpeg**: a controlled local child process (`shell: false`, argument array) for remux and MP4 conversion. Never a long-running server.
- **CaptureProvider**: a small interface so a native backend can be added later without speculative plugin infrastructure.
