# FrameCapt 0.1.0-alpha.3 — privacy fix (Windows + experimental Linux)

> **Alpha software.** FrameCapt has had very little real-world use, so keep your own copies of anything important. Nothing is code-signed yet.
>
> - **Windows**: SmartScreen will warn when you run the installer.
> - **Linux**: this build is **experimental**. See [Linux limitations](#linux-experimental).

FrameCapt is an offline screenshot and screen-recording app. There is no account, no cloud and no telemetry: nothing leaves your computer. It is free software (GPL-3.0-only). The name FrameCapt is provisional.

**New in alpha.3 (privacy fix):** Chromium's built-in spellchecker could download its English dictionary from Google on Linux, even though FrameCapt never checks spelling. This affected the Linux packages of alpha.2. The spellchecker is now switched off completely on every platform, and an automated test enforces it. No such connection was ever measured on Windows. If you use the alpha.2 Linux package, please update. Also new: GitHub now runs the full automated test suite on both Windows and Linux for every change.

## Download

| Platform            | File                                            | What it is                                                                                                                      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 x64   | `FrameCapt-Setup-0.1.0-alpha.3.exe`             | **Recommended for Windows.** A per-user installer. It needs no administrator rights and installs to `%LOCALAPPDATA%\FrameCapt`. |
| Windows             | `FrameCapt-win32-x64-0.1.0-alpha.3.zip`         | A portable build. Unzip it and run `FrameCapt.exe`.                                                                             |
| Ubuntu / Debian x64 | `framecapt_0.1.0.alpha.3_amd64.deb`             | **Recommended for Ubuntu.** Install with `sudo apt install ./framecapt_*.deb`.                                                  |
| Any Linux x64       | `FrameCapt-0.1.0-alpha.3-x64.AppImage`          | A portable build. Run `chmod +x` on it, then run it.                                                                            |
| —                   | `FrameCapt-0.1.0-alpha3-full.nupkg`, `RELEASES` | Windows update-feed files. You don't need them to install.                                                                      |
| —                   | `SHA256SUMS.txt`                                | Checksums for every file.                                                                                                       |
| —                   | `ffmpeg-9.0.2.tar.xz` (+ `.asc`)                | Source of the bundled FFmpeg (see [Source and licenses](#source-and-licenses)).                                                 |

## Installing on Windows

1. Download `FrameCapt-Setup-0.1.0-alpha.3.exe`. Optionally, check it with `Get-FileHash` in PowerShell against `SHA256SUMS.txt`.
2. Run it. SmartScreen says _"Windows protected your PC"_ because the build isn't signed yet. Click **More info**, then **Run anyway**.
3. Press `Ctrl+Shift+3` from anywhere to grab a region.

To uninstall, go to **Settings → Apps → FrameCapt**. Your captures, settings and history are kept.

## Installing on Ubuntu / Debian

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt
sudo apt install ./framecapt_0.1.0.alpha.3_amd64.deb
framecapt            # or open "FrameCapt" from the app menu
```

Uninstall with `sudo apt remove framecapt`. Your captures (`~/Pictures/FrameCapt`, `~/Videos/FrameCapt`) and settings (`~/.config/FrameCapt`) are kept.

To use the AppImage instead: `chmod +x FrameCapt-0.1.0-alpha.3-x64.AppImage && ./FrameCapt-0.1.0-alpha.3-x64.AppImage`. It needs `libfuse2` (`sudo apt install libfuse2t64` on Ubuntu 24.04 or later), or you can run it with `--appimage-extract-and-run`.

## What's in FrameCapt

- **Screenshots** of a screen, a window or a region. The editor has crop, arrow, rectangle, text and **solid redaction**; redactions are burned into the saved file, the clipboard copy and the history thumbnail. Undo/redo and zoom are included.
- **Screen recording** of a screen, a window or a region, at 1080p or source resolution and 30 or 60 fps.
  - Audio: microphone on both platforms, plus system audio on Windows.
  - Controls: pause/resume, a countdown, and a floating toolbar with a timer.
- **Crash-safe recording** with best-effort recovery after a crash.
- **MP4 export** (H.264 + AAC) with progress and cancel.
- **History** with search and thumbnails.
- **Desktop**: global shortcuts, a tray icon, launch at login (off by default), light/dark themes, and full keyboard access.

Default shortcuts: `Ctrl+Shift+1/2/3` take screenshots (screen/window/region), `Ctrl+Shift+5/6/7` record, `Ctrl+Shift+9` pauses and `Ctrl+Shift+0` stops. All are configurable.

## How this build was tested

- **Windows** (Windows 11 x64, two monitors):
  - **Automated tests**: unit, UI and real-capture suites.
  - **30-minute recording**: 1080p30 at 29.7 fps, with audio/video drift of +10 ms.
  - **Installer**: the alpha.1 installer was silently installed, used for a real screenshot, recording and MP4 export, then uninstalled with user files kept. The app made no network connections. The alpha.3 Windows build adds the spellchecker switch-off and test changes. Its packaged app passed the smoke checks (UI, security bridge, bundled FFmpeg, network blocked), and GitHub CI passed lint, the unit tests, the UI tests and packaging on a Windows runner.
- **Linux** (WSL2 Ubuntu 26.04 and Xvfb):
  - **Automated tests**: the unit and UI suites pass.
  - **Real capture on a virtual X11 display**: a screenshot at exact size, a recording, and an MP4 export. All were checked with the bundled ffprobe.
  - **Packages**: the `.deb` was installed, run, recorded with and uninstalled (user files kept), and the AppImage starts.
  - **Not yet tested**: a real Ubuntu desktop (GNOME/KDE on physical hardware). Please report how it goes.

## Linux (experimental)

- **No system audio** on Linux yet; the microphone works. The switch is shown as unavailable rather than recording silence.
- **X11 only.** FrameCapt runs through X11/XWayland. On Wayland sessions (the Ubuntu default), capturing native Wayland windows may give black frames and global shortcuts may not work. Choosing **"Ubuntu on Xorg"** at login works best.
- **Toolbar may appear in recordings.** Linux can't hide the recording toolbar from capture in full-screen recordings. It is kept outside the area in region recordings.
- **Untested** on Ubuntu 22.04/24.04 desktops, other distributions, tray icons under GNOME (that needs the AppIndicator extension), and HiDPI layouts.
- **Wording**: some interface text still says "Windows" or "Recycle Bin"; on Linux, deleted files go to the desktop Trash.

## Known limitations (all platforms)

- Unsigned builds.
- Crash recovery is best effort; expect to lose up to about a second of video.
- DRM-protected video captures as black, and minimized windows can't be picked.
- A region recording stays on one monitor. Redaction is for screenshots only.
- There are no automatic updates yet. Check this page for new builds.

## Source and licenses

- **FrameCapt**: GPL-3.0-only. The source is this repository at tag `v0.1.0-alpha.3`; GitHub attaches the "Source code" archives below.
- **Bundled FFmpeg 9.0.2**: GPL-3.0-or-later.
  - **Windows** uses the Gyan.dev essentials build. **Linux** uses a BtbN static GPL build of the 9.0.2 release branch.
  - The FFmpeg 9.0.2 release source is attached, with its signature. The signature verifies against the FFmpeg release key, fingerprint `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`.
  - The external libraries and build details are in `THIRD_PARTY_NOTICES.md`, which ships inside the app.
- **Brand**: the FrameCapt name and logo are not licensed under the GPL.

## Feedback

Please report bugs through this repository's **Issues** tab. Include your OS version and, on Linux, your desktop environment and whether you use Wayland or X11.

## Checksums (SHA-256)

```
9d63147035e882dbe3c2c447c0df1a37a328965f0af0c3d731588b17055251cc  FrameCapt-Setup-0.1.0-alpha.3.exe
bb6e47cc0effe371c2b9d0d7748db451831427819e580eb1a439a4fa150dcbd0  FrameCapt-win32-x64-0.1.0-alpha.3.zip
35630b8808968d91cb9c22fece777fae7afb00228c900389e15055d0c24ab585  framecapt_0.1.0.alpha.3_amd64.deb
5cf04747484ea5c453443a9c06b2c6b165ca0d3ebe412ce2b79e9cb023f8991b  FrameCapt-0.1.0-alpha.3-x64.AppImage
f99f9ca1745d1799705daffc590fb45aa0bfb26c73a6d89b1f4d3b3f52222496  FrameCapt-0.1.0-alpha3-full.nupkg
c3d7f702d6882a5b0e762c5afe3c1650e611121504001b7bfbbc3bdb1a120d1c  RELEASES
8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg-9.0.2.tar.xz
d617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2  ffmpeg-9.0.2.tar.xz.asc
```
