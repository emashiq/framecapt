# Project contract

## Product and scope
Build Framelet, a provisional-name Windows-first offline screenshot and recording application for developers, QA, freelancers and support teams. Primary flow: shortcut → select source/region → capture/record → annotate or review → copy/save. No account required.
Use Electron, TypeScript, React and Vite. Start with npm and one lockfile unless the existing repository already uses another package manager. Use a supported stable Electron version, verify compatibility from primary documentation and pin reproducible dependency resolutions. Use Electron Forge unless the repository already has a working equivalent.

MVP:
- Screenshot: screen, window, rectangular region; PNG/JPEG; clipboard image; crop, arrow, rectangle, text, solid opaque redaction; undo/redo.
- Video: screen/window/region; 1080p/30fps default where feasible; source-resolution option; microphone and Windows system audio separately selectable; pause/resume/stop; visible timer and status.
- Disk-backed capture, bounded memory, finalized playable exports, error reporting and a documented recovery policy.
- Tray, configurable shortcuts, floating recording toolbar, settings and local capture history.
- Windows installer configuration, update integration safely disabled until a real update source exists, build automation, tests and release documentation.
Defer cloud hosting/sync, AI, OCR, webcam overlays, full timeline, streaming, team accounts, billing integration, macOS/Linux product support and native backend rewrites unless required to solve a measured blocking defect.

## Process boundaries
- Main: source discovery, capture authorization, windows, tray, shortcuts, filesystem and export process lifecycle.
- Preload: explicit typed allowlisted methods. No raw ipcRenderer or arbitrary filesystem/process API exposed.
- Renderer: product UI, editor, preview and browser media pipeline.
- CaptureProvider boundary for future native backend, without speculative plugin infrastructure.
- FFmpeg is a controlled local child process for necessary postprocessing, not a long-running server.
Use explicit lifecycle states (idle, selecting, starting, recording, paused, stopping, processing, completed, error) with cancellation semantics. Reject duplicate commands and clean up tracks, streams, timers, audio contexts, windows and processes.

## Capture correctness
Electron desktopCapturer enumerates sources; getDisplayMedia capture must be authorized through Electron's supported APIs. Verify exact APIs for the pinned version. Region selection is not assumed to be a native capability. Map display-independent coordinates to pixels, account for negative monitor origins, scaling and rotation. For MVP, restrict a rectangular recording region to one monitor with clear UI; don't silently crop the wrong screen.
Use a live video frame or otherwise verified full-resolution source for screenshots. Do not upscale a small source thumbnail and call it full-resolution.
Benchmark canvas-based cropped recording. If unsuitable, document evidence and make a bounded design adjustment. Do not spend weeks implementing an unneeded native engine.
Never capture the selection overlay or toolbar into output unintentionally. State actual platform limitations rather than claiming universal exclusion.
Validate supported MIME/container/codec combinations at runtime. Prefer reliable WebM recording; add tested MP4 conversion using an appropriate FFmpeg build. Never rename an extension as conversion.

## Audio and persistence
Mix requested microphone and system audio into one recording track using an explicit audio graph. Prevent speaker monitoring/echo; preserve separate enable controls, device selection, mute and levels. Handle silent/ended tracks and unavailable devices visibly.
MediaRecorder chunks are not necessarily independently decodable. Choose and document an incremental persistence strategy with sequencing, acknowledgments/backpressure, bounded queues, a session manifest and tested finalization. Never concatenate arbitrary containers and assume they work.
Support long recordings without retaining the full file in renderer RAM. Apply maximum chunk sizes and validate session IDs/sequence numbers across IPC.
On low disk, write failure, source loss or app exit, stop safely and preserve useful temporary data. Recovery is best effort unless proven by interruption tests. Do not promise lossless crash recovery.
Do not silently delete original recordings after export or remove user files during history cleanup. Store metadata separately; handle externally moved/deleted files.

## Security and privacy
contextIsolation on, nodeIntegration off for the renderer, sandbox on where supported; restrictive CSP; local UI only. Validate IPC payloads and sender/frame origin. Use save/open dialogs or main-owned IDs instead of arbitrary renderer paths. Launch FFmpeg with argument arrays and shell disabled.
No telemetry, cloud uploads or remote media processing by default. Redaction must flatten into exported image pixels and clipboard content. Do not accidentally publish sensitive unredacted thumbnails. History should show final edited output after redaction; originals must be visibly managed.
Never bypass runtime permissions, disable security checks to get builds passing, embed secrets or download executables from unverified locations.

## UX
Small, responsive desktop UI. Light/dark system theme; keyboard-accessible controls; focus management and legible status/errors. Compact home actions, clear source picker, drag-region selection, floating toolbar, editor and history. Avoid onboarding walls and unnecessary settings. Starting and stopping a capture must be obvious. Long work needs cancel/progress and predictable output locations.

## Open source and commercial direction
Default proposed project license: GPL-3.0-only for a fully open-source app. Verify dependency compatibility and use the actual canonical license text, not an invented summary. Do not copy unlicensed icons, code or branding.
Prepare third-party notices and record the exact FFmpeg source/build options/license. Do not assume every FFmpeg binary has the same license. Commercial release review must cover codec/patent questions where applicable; do not invent legal clearance.
The paid offering is official packaging, convenience and defined support/update terms; it does not remove open-source redistribution rights. No license-key gate or proprietary premium features in this MVP. Do not create a CLA/relicense other contributors' code without owner direction.
No purchases, store submissions, public releases or remote deployment in this build task. Prepare configurations/docs and identify final owner actions.

## Completion evidence
Use tests for state transitions, coordinate mapping, redaction flattening, session validation/backpressure and recovery/export behavior. Use mock providers only for automated UI testing, clearly isolated from production.
Record Windows manual tests separately from headless tests. Measure performance on a named machine: OS, CPU, RAM, Electron version, resolution, duration, CPU samples, whole-app process-tree memory and output properties.
Performance goals to investigate, not fabricated guarantees: idle CPU near zero, stable memory after warmup, no growing recorder queue, usable 1080p/30fps recording for 30 minutes, no material A/V drift. Set concrete pass/fail thresholds from initial baseline and user workflow.
Final status must distinguish implemented, actually verified and externally blocked. No fake test results, release links, screenshots, payment credentials or code-signing identities.

