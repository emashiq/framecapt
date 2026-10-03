# Building and testing on Linux (experimental)

FrameCapt for Linux x64 is **experimental** (owner decision 2026-10-03, ADR-038). It produces a `.deb` (Ubuntu/Debian) and an `AppImage`. It was built and tested in the owner's WSL2 Ubuntu 26.04 (WSLg) and on a virtual X server (Xvfb + openbox). WSLg is not a real desktop: see [capability-matrix.md](capability-matrix.md) for exactly what was and was not verified.

## What was installed in the test machine (WSL2, Ubuntu 26.04.1 LTS, 2026-10-03)

| What                                                                                                                                                                                                                           | How                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24.21.0 (npm 11.19.0)                                                                                                                                                                                                  | Official `node-v24.21.0-linux-x64.tar.xz` from nodejs.org, SHA-256 checked against `SHASUMS256.txt`, unpacked to `/opt/node`, symlinks in `/usr/local/bin`                                                        |
| apt: `fakeroot dpkg-dev libnss3 libgtk-3-0t64 libasound2t64 libgbm1 libxss1 libnotify4 xdg-utils libatspi2.0-0t64 libsecret-1-0 xvfb libfuse2t64 xdotool xauth libxtst6 libxkbcommon0 libdrm2 libcups2t64 file squashfs-tools` | Electron runtime libraries, packaging tools (`fakeroot`/`dpkg` for the .deb, `squashfs-tools` for the AppImage), `xvfb` for headless tests, `libfuse2t64` to run an AppImage without `--appimage-extract-and-run` |
| apt: `openbox`                                                                                                                                                                                                                 | A tiny window manager: the e2e suite needs one (minimize, focus and therefore the clipboard do not work on a bare Xvfb)                                                                                           |
| A user `tester`                                                                                                                                                                                                                | Electron refuses to run as root without `--no-sandbox`; the app and every test run as a normal user                                                                                                               |

On Ubuntu 22.04 and older, the `t64` suffixes do not exist (`libgtk-3-0`, `libasound2`, ...).

## Build

Build from a clone on the Linux file system. Never share `node_modules` with Windows (native binaries differ); in WSL do not build under `/mnt/c` or `/mnt/e`.

```bash
git clone <repo> framecapt && cd framecapt
npm ci
npm run lint && npm run typecheck && npm test      # 784 tests; the real-ffmpeg ones need the next line first
npm run fetch:ffmpeg                                # pinned linux64 GPL FFmpeg, SHA-256 verified (docs/ffmpeg.md)
npm run make                                        # premake also fetches the pinned AppImage runtime
```

`npm run make` writes:

```
out/make/deb/x64/framecapt_<version>_amd64.deb            (version 0.1.0-alpha.1 becomes 0.1.0~alpha.1)
out/make/AppImage/x64/FrameCapt-<version>-x64.AppImage
out/FrameCapt-linux-x64/                                   the unpacked app (executable: framecapt)
```

Packages are UNSIGNED (no GPG signature, no AppImage signature) and not byte-for-byte reproducible.

## Tests

| Command                                                                                                       | What it does                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                    | Unit tests (same suite as on Windows; Squirrel hook tests run with `process.platform` set to `win32`)                                                         |
| `bash scripts/xvfb-wm.sh npm run test:e2e`                                                                    | Mock-provider e2e suite on a private Xvfb with openbox                                                                                                        |
| `bash scripts/xvfb-wm.sh npm run test:native:linux`                                                           | **Real** capture: screenshot, 4 s recording, MP4 export, checked with the bundled ffprobe (needs a real build: run after `npm run make` or `npm run package`) |
| `FRAMECAPT_LINUX_PIXELS=0 npm run test:native:linux`                                                          | Same on WSLg/XWayland, where the captured pixels are black (see below): only sizes, codecs and decoding are asserted                                          |
| `npm run smoke:packaged`                                                                                      | The unpacked packaged app starts, fuses, CSP, bridge                                                                                                          |
| `node scripts/smoke-linux.mjs --user <name>` (as root) or `npm run smoke:linux` (user with passwordless sudo) | Installs the .deb with apt, runs it, records 3 s, toggles launch at login, runs the AppImage, uninstalls, checks the user's files stayed                      |

Under WSLg set `DISPLAY=:0` (and `XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir`, `PULSE_SERVER=/mnt/wslg/PulseServer`) if your shell did not.

On a CI runner with Ubuntu 24.04+ the unpackaged Electron in `node_modules` has no setuid `chrome-sandbox`; allow unprivileged user namespaces (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`) or the renderer sandbox cannot start. The `.deb` installs `chrome-sandbox` setuid root (4755), so installed copies do not need that.

## Install and uninstall

```bash
sudo apt install ./framecapt_0.1.0~alpha.1_amd64.deb     # installs to /usr/lib/framecapt, /usr/bin/framecapt, a desktop entry and icon
framecapt                                                  # or start it from the application menu (Graphics)
sudo apt remove framecapt                                  # removes the program only
chmod +x FrameCapt-*.AppImage && ./FrameCapt-*.AppImage    # AppImage; --appimage-extract-and-run when FUSE (libfuse2) is missing
```

Your data is never removed: `~/.config/FrameCapt` (settings, history, logs), `~/Pictures/FrameCapt`, `~/Videos/FrameCapt` and an optional `~/.config/autostart/framecapt.desktop` stay. Launch at login (Settings) writes or removes that autostart entry (the AppImage path when started from an AppImage).

## Linux-specific behavior

- **X11 only.** `app.commandLine.appendSwitch('ozone-platform', 'x11')` runs before `ready` (`src/main/linux.ts`). On a Wayland session the app runs through XWayland. Reason: ADR-038.
- **Mic only, no system audio.** Chromium's `audio: 'loopback'` exists on Windows only. The System audio switch is disabled with "Not available on Linux yet"; a saved "on" setting is shown off; the main process drops the request, so there is never a silent "system audio" track. Microphone capture uses PulseAudio or PipeWire through Chromium.
- **The recording toolbar may be recorded.** `setContentProtection` does nothing on Linux. A note under Record options says so. Region recordings place the toolbar outside the region; Stop works from the global shortcut.
- **Folders.** If Electron cannot resolve the XDG Pictures/Videos directory, `~/Pictures/FrameCapt` and `~/Videos/FrameCapt` are used (created when the first file is saved).
- **Trash and open.** Deleting from History uses `shell.trashItem` (needs `gio`, `kioclient` or `trash-cli`, which the .deb depends on); failures are reported, not hidden. The messages still say "Recycle Bin" (wording is not yet platform-aware).
- **Wording.** Several UI strings still say "Windows" (theme, microphone, tray); they are not yet platform-aware.
- **Updates.** None (same as Windows).
