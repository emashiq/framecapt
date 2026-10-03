# FrameCapt 0.1.0-alpha.1 — first alpha

> **Alpha software.** This is the first test build of FrameCapt. It works end to end on the developer's machine, but it has had very little real-world use. Keep your own copies of anything important. The installer is **not code-signed**, so Windows SmartScreen will warn you (see [Installing](#installing)).

FrameCapt is an offline screenshot and screen-recording app for Windows. There is no account, no cloud and no telemetry: nothing leaves your computer. It is free software (GPL-3.0-only). The name FrameCapt is provisional.

## Download

| File                                            | What it is                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `FrameCapt-Setup-0.1.0-alpha.1.exe`             | **Recommended.** A per-user installer. It needs no administrator rights, installs to `%LOCALAPPDATA%\FrameCapt` and adds a Start Menu shortcut. |
| `FrameCapt-win32-x64-0.1.0-alpha.1.zip`         | A portable build. Unzip it anywhere and run `FrameCapt.exe`. There are no shortcuts and no uninstaller.                                         |
| `FrameCapt-0.1.0-alpha1-full.nupkg`, `RELEASES` | Squirrel update-feed files, for a future update channel. You don't need them to install.                                                        |
| `SHA256SUMS.txt`                                | Checksums for every file above.                                                                                                                 |
| `ffmpeg-9.0.2.tar.xz` (+ `.asc`)                | Source code of the bundled FFmpeg, signed by the FFmpeg release key (see [Source and licenses](#source-and-licenses)).                          |

Requirements: Windows 10 or 11, 64-bit, with about 230 MB of disk space. Only Windows 11 has been tested.

## Installing

1. Download `FrameCapt-Setup-0.1.0-alpha.1.exe`.
2. Optional: check the file against `SHA256SUMS.txt` by running `Get-FileHash .\FrameCapt-Setup-0.1.0-alpha.1.exe` in PowerShell.
3. Run it. Windows SmartScreen says _"Windows protected your PC"_ because the build isn't signed yet. Click **More info**, then **Run anyway**.
4. FrameCapt opens. Press `Ctrl+Shift+3` from anywhere to grab a region.

To uninstall, go to **Settings → Apps → FrameCapt → Uninstall**. Your screenshots, recordings, settings and history are kept.

## What's in this alpha

- **Screenshots** of a screen, a window or a region. Screen and region captures are pixel-exact.
  - **Editor**: crop, arrow, rectangle, text and **solid redaction**. Redactions are burned into the saved PNG or JPEG, the clipboard image and the history thumbnail. Undo/redo and zoom are included.
- **Screen recording** of a screen, a window or a region, at 1080p or source resolution and 30 or 60 fps.
  - Audio: optional microphone and Windows system audio.
  - Controls: pause/resume, a 3-2-1 countdown, and a floating toolbar with timer, mute and level meters. The toolbar doesn't appear in your video.
- **Crash-safe recording**: video is written to disk as you record. After a crash, FrameCapt offers to recover what was saved (best effort).
- **MP4 export** (H.264 + AAC) with progress and cancel. The original WebM is always kept.
- **History** of your captures with search, thumbnails, a "file moved" state, and delete to the Recycle Bin.
- **Desktop**: configurable global shortcuts with conflict warnings, a tray icon, close-to-tray, launch at login (off by default), and light/dark themes. The app is fully keyboard accessible.
- **New logo**, startup screen and installer animation.

Default shortcuts (all configurable):

| Screenshots           | Recordings                  |
| --------------------- | --------------------------- |
| Screen `Ctrl+Shift+1` | Screen `Ctrl+Shift+5`       |
| Window `Ctrl+Shift+2` | Window `Ctrl+Shift+6`       |
| Region `Ctrl+Shift+3` | Region `Ctrl+Shift+7`       |
|                       | Pause/resume `Ctrl+Shift+9` |
|                       | Stop `Ctrl+Shift+0`         |

## How this build was tested

All of this ran on one Windows 11 x64 PC with two monitors (3440×1440 and 2560×1440):

- **Automated tests**: 767 unit tests, 157 UI tests and 46 tests with real screen capture.
- **30-minute recording**: 1080p30, averaging 29.7 fps, with audio/video drift of +10 ms.
- **Crash recovery**: tested by forcibly killing the app mid-recording.
- **Installer**: this exact `FrameCapt-Setup-0.1.0-alpha.1.exe` was silently installed, used for a real screenshot, recording and MP4 export, then uninstalled with user files kept. The app made no network connections.

## Known limitations

- The installer and app are **unsigned**, so SmartScreen warns.
- Untested on Windows 10, ARM, mixed-DPI or rotated monitor layouts, and with screen readers.
- Crash recovery is best effort; expect to lose up to about a second of video.
- DRM-protected video shows as black, and minimized windows can't be picked (Windows limitations).
- A region recording stays on one monitor. Redaction is for screenshots only.
- There are no automatic updates yet. Check this page for new builds.

## Source and licenses

- **FrameCapt**: GPL-3.0-only. The source is this repository at tag `v0.1.0-alpha.1`; GitHub attaches the "Source code" archives below.
- **Bundled FFmpeg**: 9.0.2, Gyan.dev "essentials" build, GPL-3.0-or-later. Its source, `ffmpeg-9.0.2.tar.xz`, is attached to this release with FFmpeg's detached signature. The signature verifies against the FFmpeg release key, fingerprint `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`. The external libraries in that build and their licenses are listed in `THIRD_PARTY_NOTICES.md`, which also ships inside the app.
- **Electron/Chromium**: their notices ship in the app as `LICENSE` and `LICENSES.chromium.html`.
- **Brand**: the FrameCapt name and logo are not licensed under the GPL.

## Feedback

Please report bugs through this repository's **Issues** tab, using the bug-report template. Include your Windows version and monitor setup.

## Checksums (SHA-256)

```
2d09a9d895ba4348951f94e1fc3abae9e76046a32d485d60ae7545cf4ebd99cc  FrameCapt-Setup-0.1.0-alpha.1.exe
f945598463ab81cd7395f28bb2f0b521776e9855a3e7429532d22e6e5c19fde3  FrameCapt-win32-x64-0.1.0-alpha.1.zip
3a7b7fb1829658b6af2e9072ea3a14b994f30c77f19c6ad558e6629d67425f1c  FrameCapt-0.1.0-alpha1-full.nupkg
0fd0ece8261d5e8c704f081fc8c8c7bb5e384a7da9641b78f130b41a810e58a4  RELEASES
8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg-9.0.2.tar.xz
d617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2  ffmpeg-9.0.2.tar.xz.asc
```
