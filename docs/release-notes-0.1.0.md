# FrameCapt 0.1.0 (beta) - release notes

Status: draft for an unreleased beta. Nothing has been published; the installer is **unsigned**. FrameCapt is a provisional name.

FrameCapt is an offline screenshot and screen-recording app for Windows. No account, no cloud, no telemetry: nothing leaves your computer. It is free software (GPL-3.0-only).

## Highlights

- **Screenshots** of a screen, a window or a region, in the editor with crop, arrow, rectangle, text and **solid opaque redaction** that is flattened into the saved file, the clipboard image and the history thumbnail. Save as PNG or JPEG, or copy to the clipboard.
- **Screen recording** of a screen, window or region at 1080p or source resolution, 30 or 60 fps, with optional microphone and Windows system audio in one track, pause/resume, a floating toolbar with a timer and an optional countdown.
- **Safer recordings**: video is written to disk as you record, finished into a seekable WebM, and an unfinished recording can be recovered after a crash (best effort).
- **MP4 export** (H.264 + AAC) with progress and cancel.
- **History** of your captures with search, thumbnails, "file moved" handling and delete-to-Recycle-Bin.
- Global **shortcuts** (`Ctrl+Shift+1/2/3` screenshots, `Ctrl+Shift+5/6/7` recordings, `Ctrl+Shift+0` stop, `Ctrl+Shift+9` pause; all configurable), tray icon, light/dark theme, keyboard-accessible UI.

## Installing

- `FrameCapt-Setup-0.1.0.exe`: per-user installer, no administrator rights, installs to `%LOCALAPPDATA%\FrameCapt`. **It is not code-signed, so Windows SmartScreen will show a warning.** Check the SHA-256 on the release page against the file you downloaded before running it.
- `FrameCapt-win32-x64-0.1.0.zip`: portable build (unzip and run `FrameCapt.exe`).
- Uninstalling keeps your settings, history and captures.
- About 229 MB, mostly the bundled FFmpeg.

## What was verified

On one Windows 11 x64 machine with two monitors: real screenshots of both screens at exact resolution, window and region capture, screen/window/region recording with system audio, a 30-minute 1080p30 recording (29.72 fps average, audio/video drift +10 ms), recovery after forcibly killing the app during a recording, MP4 export with cancel, a silent install and uninstall of the unsigned installer, and zero network connections during 60-second runs. Details: [capability-matrix.md](capability-matrix.md), [performance.md](performance.md).

## Known limitations

- Unsigned installer and executables (SmartScreen warning).
- Tested on Windows 11 x64 only. Windows 10 is expected to work but is untested; Windows on ARM is not targeted.
- Mixed-DPI, rotated or negative-origin monitor layouts, screen readers, power loss during recording and a real full disk were not tested on real hardware (logic is covered by automated tests).
- Recovery of an unfinished recording is best effort: expect to lose up to about a second of media; a recording whose header was never written cannot be repaired.
- DRM-protected content is captured as black (Windows behavior); minimized windows cannot be picked.
- No video redaction; redaction applies to screenshots.
- No automatic updates in this build; no macOS or Linux version.
- Recording regions are limited to one monitor.
- 60 fps and long region/microphone recordings were not benchmarked.
- Open owner items before a public release: signing, name clearance, FFmpeg source distribution, codec/patent review ([OWNER-TASKS.md](OWNER-TASKS.md)).

## Source and licenses

FrameCapt is GPL-3.0-only. The installer includes FFmpeg 9.0.2 (Gyan "essentials" build, GPL-3.0-or-later) and Electron/Chromium; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The corresponding source for the binaries is `[OWNER: add source and written-offer location for this release]`.

## Checksums

`[OWNER: paste SHA-256 values from SHA256SUMS.txt of the release build]`. (The final local build on 2026-10-03 produced `FrameCapt-Setup-0.1.0.exe` with a SHA-256 beginning `75def59a`; builds are not bit-for-bit reproducible, so use the checksum of the file you publish.)
