# Building Framelet on Windows

Framelet is built and tested on Windows 11 x64. Other platforms are not supported.

## Prerequisites

- **Windows 10 or 11, x64** with an interactive desktop for the native tests (the unit tests and the build do not need one).
- **Node.js 24** (the project was developed with 24.15.0) and **npm** (11.12.1 was used). One lockfile (`package-lock.json`) is committed; use `npm ci`, not `npm install`.
- **git**.
- Internet access for the first `npm ci` and for downloading Electron and FFmpeg (both are pinned by SHA-256).
- **FFmpeg is not installed by you**: `scripts/fetch-ffmpeg.mjs` downloads the pinned FFmpeg 9.0.2 build (Gyan "essentials", about 115 MB zip, GPL-3.0-or-later; see [ffmpeg.md](ffmpeg.md)) into `vendor/ffmpeg/win32-x64/`, verifies its SHA-256 and does nothing if it is already there. It runs automatically before `start`, `package`, `make` and `package:e2e`. It needs no Python and no PowerShell.
- Python is **not** required. No signing certificate is required (builds are unsigned unless you set the signing variables, see [release-process.md](release-process.md)).

## Commands

```
git clone <repository-url> framelet
cd framelet
npm ci                      # install exactly what package-lock.json says
npm run fetch:ffmpeg        # optional: done automatically by the commands below
npm start                   # run the app in development (Electron Forge + Vite)
npm run lint                # ESLint
npm run typecheck           # three TypeScript projects: main/shared, renderer, e2e
npm test                    # unit and integration tests (vitest)
npm run test:e2e            # UI tests with a synthetic capture source (builds a test app first)
npm run test:native         # real screen/audio capture, shortcuts, recovery (needs an interactive desktop)
npm run bench:recording     # 30-minute 1080p30 recording benchmark (interactive desktop, 30 minutes)
npm run package             # the unpacked app, no installer
npm run make                # installer and portable zip
```

Notes:

- `npm run test:e2e` and `npm run test:native` start real Electron windows. `test:native` records your real screen and plays a test tone, and the shortcut tests press real global hotkeys: close other apps that use `Ctrl+Shift+1..9` first, and do not touch the mouse or keyboard while it runs. Running them is optional for contributors; the GitHub workflow runs lint, typecheck, unit tests, the e2e suite and a packaging build ([testing.md](testing.md)).
- `npm run smoke:installed` (after `make`) **installs and uninstalls Framelet on the machine** it runs on.
- E2E builds contain a mock capture provider; `npm run check:mocks` verifies that a production build does not. Never package an E2E build (`npm run package` and `make` clean the build folder first).
- Tests that write evidence files do so only with `FRAMELET_WRITE_EVIDENCE=1`.

## Output locations

| Command                    | Output                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                | Build output in `.vite/` (gitignored); user data in `%APPDATA%\Framelet` (likely shared with an installed app; unverified)                                                                  |
| `npm run package`          | `out/Framelet-win32-x64/` (the unpacked app: `Framelet.exe`, `resources/app.asar`, `resources/ffmpeg/win32-x64/`)                                                                           |
| `npm run make`             | `out/make/squirrel.windows/x64/Framelet-Setup-0.1.0.exe` (per-user installer, about 229 MB), `Framelet-0.1.0-full.nupkg`, `RELEASES`; `out/make/zip/win32/x64/Framelet-win32-x64-0.1.0.zip` |
| `npm run record:artifacts` | `out/make/SHA256SUMS.txt` and `docs/evidence/phase10/artifacts.json`                                                                                                                        |
| FFmpeg                     | `vendor/ffmpeg/win32-x64/` (gitignored)                                                                                                                                                     |

The installer and executables are **unsigned** unless you provide a certificate through `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`; the build log says which. Builds are not bit-for-bit reproducible (archives embed timestamps).

## Troubleshooting a build

- The first run of Electron after `npm ci` downloads the Electron binary lazily; a slow network can make `npm start` pause.
- Stray `electron.exe` processes left behind by a crashed test run hold global shortcuts and break `test:native`; end them in Task Manager first.
- "FFMPEG_MISSING": run `npm run fetch:ffmpeg`.
- More: [packaging.md](packaging.md), [release-process.md](release-process.md), [testing.md](testing.md).
