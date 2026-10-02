# Changelog

All notable changes to Framelet are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The name Framelet is provisional.

## [Unreleased]

### 0.1.0 (beta, not yet released)

#### Added

- Screenshots of a screen, a window or a rectangular region (one monitor per region), with pixel-exact full-resolution capture of screens, saved as PNG or JPEG or copied to the clipboard.
- Screenshot editor: crop, arrow, rectangle, text, solid opaque redaction flattened into exported pixels, clipboard image and history thumbnail, 200-step undo/redo, zoom and keyboard shortcuts.
- Screen, window and region video recording (VP9 + Opus WebM) at 1080p or source resolution, 30 or 60 fps, with optional microphone and Windows system audio mixed into one track, pause/resume/stop, floating toolbar with timer and optional 3-2-1 countdown.
- Disk-backed recording sessions (sequenced, acknowledged, bounded chunks; manifest), FFmpeg remux into a seekable WebM, disk-space checks, and best-effort recovery of unfinished recordings at the next start.
- MP4 export (H.264 + AAC) with progress and cancel, using a bundled FFmpeg 9.0.2 (Gyan "essentials" build, GPL-3.0-or-later).
- Local capture history with search, thumbnails from flattened output, missing-file handling, and delete-to-Recycle-Bin.
- Settings, configurable global shortcuts with conflict detection, tray icon, close-to-tray, launch-at-login option, light/dark theme following Windows, keyboard-accessible UI.
- Windows installer (Squirrel, per-user, **unsigned**) and portable zip; production UI served from the local `app://framelet` scheme; update adapter present but disabled until an update source exists.
- No telemetry, no uploads, no network requests of its own (measured).
- Open-source documentation: README, user guide, build guide, contributing guide, code of conduct, security policy, privacy statement, third-party notices, GPL-3.0-only license.

#### Known limitations

- The installer and executables are not code-signed; Windows SmartScreen will warn.
- Tested on Windows 11 x64 only; Windows 10, ARM, mixed-DPI/rotated monitors and screen readers were not tested on real hardware.
- Crash recovery is best effort (expect to lose up to about a second of media; power-loss behavior was not tested).
- No automatic updates; no macOS or Linux builds.
- H.264/AAC/VP9/Opus patent and licensing review is an open owner task; FFmpeg source distribution for binary releases is an open owner task.
