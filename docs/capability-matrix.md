# Capability matrix

Status values: **Not started**, **Foundation** (scaffolding only), **Implemented**, **Blocked**. "Verified on host?" means actually exercised on the build host, not assumed.

Host used for verification: Windows 11 Pro (10.0.26300), AMD Ryzen 7 7700, 63 GB RAM, interactive desktop, two monitors (3440x1440 at 0,0 and 2560x1440 at 3440,0 per `System.Windows.Forms.Screen`), AMD Radeon + NVIDIA RTX 5070 Ti. Electron 44.5.1.

## Platform support

| Item              | Value                     | Notes                                                                                                                                                      |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported Windows | Windows 10 and later, x64 | Electron 23+ dropped Windows 7, 8 and 8.1; Framelet pins Electron 44. Only Windows 11 was available for testing, so Windows 10 is "expected", not verified |
| Windows arm64     | Not targeted              | The packager config builds x64 only                                                                                                                        |
| macOS / Linux     | Out of scope for the MVP  | Makers are Squirrel (Windows) and ZIP (win32) only                                                                                                         |

## Capabilities

| Capability                                                             | Status                           | Verified on host? | Notes                                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron app window, secure preload bridge, typed IPC                  | Implemented                      | Yes               | Playwright e2e against the Vite build output (file://)                                                                                     |
| CSP, navigation lockdown, permission handlers                          | Implemented                      | Partly            | CSP and navigation/window.open blocking verified in e2e. Permission handlers are unit tested only; no real permission prompt was triggered |
| Single-instance lock                                                   | Implemented                      | No                | No automated test; code path is `requestSingleInstanceLock` + focus on `second-instance`                                                   |
| Electron fuses, ASAR integrity                                         | Implemented                      | Yes               | Packaged exe launch checked in phase 01                                                                                                    |
| Error boundary and renderer error reporting                            | Implemented                      | Partly            | `app:reportError` to log verified in e2e; the boundary's recovery screen is not covered by an automated test                               |
| Windows installer (Squirrel)                                           | Foundation                       | No                | Maker configured; `npm run make` not run in phase 01                                                                                       |
| Auto-update                                                            | Not started (disabled by design) | n/a               | No update source exists                                                                                                                    |
| Screenshot: screen                                                     | Not started                      | No                | `desktopCapturer` enumeration + live frame via `getDisplayMedia` (Electron `setDisplayMediaRequestHandler`)                                |
| Screenshot: window                                                     | Not started                      | No                | Same APIs, window sources                                                                                                                  |
| Screenshot: rectangular region                                         | Not started                      | No                | Freeze-frame overlay; one monitor only; handle negative origins and DPI scaling                                                            |
| PNG / JPEG export, clipboard image                                     | Not started                      | No                | Canvas encoding; `clipboard-sanitized-write` is already allowed for app pages                                                              |
| Annotation (crop, arrow, rectangle, text, opaque redaction, undo/redo) | Not started                      | No                | Redaction must flatten into exported pixels                                                                                                |
| Video: screen / window / region                                        | Not started                      | No                | Region recording via canvas crop is to be benchmarked before committing to it                                                              |
| Audio: microphone and system audio, separately selectable              | Not started                      | No                | Windows system (loopback) audio availability through Electron/Chromium to be verified in phase 02+                                         |
| Pause / resume / stop, timer, status                                   | Not started                      | No                | Explicit state machine planned                                                                                                             |
| Disk-backed sessions, bounded memory, recovery                         | Not started                      | No                | Sequenced chunk IPC with acks and manifest; best-effort recovery only                                                                      |
| Tray, configurable shortcuts, floating toolbar                         | Not started                      | No                | Toolbar excluded from capture via `setContentProtection` where supported                                                                   |
| Settings and local history                                             | Foundation                       | Partly            | Placeholder views only (empty states, About)                                                                                               |
| Light/dark theme following system                                      | Implemented                      | Yes (visually)    | Checked via screenshots with emulated color scheme; `nativeTheme.themeSource = 'system'`                                                   |

## Codecs and export plan

| Item                | Plan                                                                                                                                                                                                                                                 | Status      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Recording container | WebM through `MediaRecorder`, MIME/codec chosen at runtime with `MediaRecorder.isTypeSupported` (VP9/VP8 and Opus candidates). Nothing is hard-coded                                                                                                 | Not started |
| Finalization        | FFmpeg remux of the recorded session into a clean, seekable file. Chunks are not concatenated blindly                                                                                                                                                | Not started |
| MP4 export          | Real conversion with a bundled FFmpeg build (libx264 + aac), never an extension rename. The exact FFmpeg source, build options and license must be recorded in third-party notices; codec/patent review is an owner action before commercial release | Not started |

## Host capabilities

| Capability                                          | Available on build host                              |
| --------------------------------------------------- | ---------------------------------------------------- |
| Interactive Windows 11 desktop (real window launch) | Yes                                                  |
| Two monitors, different sizes                       | Yes (see above). Mixed DPI scaling not characterized |
| Microphone / system audio loopback                  | Not checked in phase 01                              |
| Code signing certificate                            | No. Installer signing is an owner action             |
| Windows 10 machine, arm64 machine                   | No                                                   |
