# Release process

Status: **prepared, nothing published.** Phase 10 produced an unsigned installer and the workflows below; no release, tag, certificate, update feed or store listing exists. Every step that needs the owner is marked **OWNER ACTION**.

## What a release contains

| File                                          | What it is                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `FrameCapt-Setup-<version>.exe`               | Squirrel.Windows per-user installer (no admin rights). The file users download           |
| `FrameCapt-<version>-full.nupkg` + `RELEASES` | The Squirrel update payload. Needed only when an update feed is configured (static host) |
| `FrameCapt-win32-x64-<version>.zip`           | Portable build: unzip and run `FrameCapt.exe`. No shortcuts, no updates                  |
| `SHA256SUMS.txt`                              | SHA-256 of every file above, written by CI (`release.yml`) or `npm run record:artifacts` |

Delta packages (`-delta.nupkg`) are produced only when `remoteReleases` (the previous feed) is configured, which it is not.

## Build locally

```
npm ci
npm run lint && npm run typecheck && npm test && npm run test:e2e
npm run make                      # clean build, fetches the pinned FFmpeg, makes the installer and the zip
npm run check:mocks               # the packaged app.asar must contain no mock provider or test hook
npm run record:artifacts          # sizes + SHA-256 + Authenticode status -> docs/evidence/phase10/artifacts.json
npm run smoke:packaged            # the fused, packaged exe loads its UI and keeps its security properties
npm run smoke:installed           # silent install, real capture + export, 60 s offline, uninstall (changes this PC)
```

The build log starts with one of

```
[framecapt] Windows code signing: DISABLED - this build is UNSIGNED (...)
[framecapt] Windows code signing: ENABLED (certificate from WINDOWS_CERTIFICATE_FILE)
```

An unsigned installer is **never** described as signed anywhere: not in the log, the release notes (`release.yml` writes "UNSIGNED" into them) or these docs. `npm run record:artifacts` reads the real Authenticode status of the installer into the evidence file.

## Signing (optional, environment only)

`forge.config.ts` reads two environment variables and nothing else; no certificate is ever committed.

| Variable                       | Meaning                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `WINDOWS_CERTIFICATE_FILE`     | Path to an Authenticode code-signing certificate (`.pfx`)                                            |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password                                                                                         |
| `WINDOWS_TIMESTAMP_SERVER`     | Optional RFC 3161 server (default `http://timestamp.digicert.com`, read by `@electron/windows-sign`) |

Both set: the packaged `.exe/.dll/.node` files (Packager `windowsSign`) and the Squirrel `Setup.exe`/`Update.exe` (maker `windowsSign`) are signed with the vendored `signtool`. Only one set: the build fails ("half configured"). Neither: unsigned.

**Not exercised.** This repository's host has no certificate, so the signing path has been wired against the `@electron/windows-sign` 2.1 and `electron-winstaller` 5.4 option types but never run. The first real signed build must be checked with `Get-AuthenticodeSignature` on `Setup.exe`, `Update.exe` and `FrameCapt.exe`, then an install test (`npm run smoke:installed`).

**OWNER ACTION**: obtain a code-signing certificate (an EV certificate or a cloud/HSM service avoids the SmartScreen reputation ramp; Microsoft Trusted Signing is an option; for a cloud service replace the `windowsSign` options by a `hookModulePath`, see the `@electron/windows-sign` README). Nothing was purchased.

## GitHub Actions

Both files are in `.github/workflows/`. They were **validated locally only** (`npx @action-validator/cli`, with a negative control that fails as expected); they have not run on GitHub.

### `ci.yml` (push and pull request to `main`)

`permissions: contents: read`. Two independent packaging jobs, Node 24, npm cache:

1. `package` (`windows-latest`): `npm ci`, `npm run make`, upload of `out/make` as `framecapt-windows-unsigned` (installer, portable ZIP and Squirrel update files; **retention 14 days**).
2. `linux` (`ubuntu-latest`): install packaging tools, `npm ci`, `npm run make`, upload of `out/make` as `framecapt-linux-experimental-unsigned` (.deb and AppImage; **retention 14 days**).

The pinned FFmpeg is cached under `vendor/ffmpeg`, keyed on `hashFiles('scripts/fetch-ffmpeg.mjs')` (the file that holds the URL and SHA-256 pin; `fetch-ffmpeg` verifies the hash regardless of the cache). Nothing is published on a push: there is no release step, no tag creation and no write permission.

CI only builds and uploads packages: lint, typecheck, unit, E2E, native, smoke, benchmark and `check:mocks` commands are run locally at appropriate development or release checkpoints. The manual draft-release workflow below has its own checks and is separate from automatic CI.

Actions are pinned to **major versions** (`actions/checkout@v7`, `setup-node@v7`, `cache@v6`, `upload-artifact@v7`, `download-artifact@v8`; the majors current on 2026-10-02). **OWNER ACTION (hardening)**: pin each to a full commit SHA and let Dependabot update them.

### `release.yml` (manual: `workflow_dispatch`, input `version`)

- Top-level `permissions: {}`; the `build` job has `contents: read`; only the `draft` job has `contents: write`.
- `build` checks that `version` equals `package.json`, runs lint, typecheck and tests, builds, runs `check:mocks`, then **verifies the signature matches the claim** (`Get-AuthenticodeSignature`: signed when secrets were present, `NotSigned` otherwise; any mismatch fails the job) and uploads `release-assets` (installer, nupkg, `RELEASES`, zip, `SHA256SUMS.txt`).
- `draft` creates a **draft** GitHub release `v<version>` with `gh release create --draft` and attaches the assets. It never publishes; publishing is a manual click.
- Secrets, referenced by name only: `WINDOWS_CERTIFICATE_BASE64` (the `.pfx`, base64) and `WINDOWS_CERTIFICATE_PASSWORD`. When either is missing the run prints a visible warning (`UNSIGNED build`) and the draft notes say "UNSIGNED".

**OWNER ACTION** to use it: create the repository secrets (above), bump `package.json` `version`, run the workflow, review the draft, publish.

## Update feed (not configured)

`src/main/updates.ts` is ready; the feed URL is compiled in from `FRAMECAPT_UPDATE_URL` at build time (default empty = "Not configured for this build", no request ever). Two supported shapes (pick one, then rebuild with the variable set):

1. **Static Squirrel feed.** Upload `RELEASES` and the `.nupkg` files of each release to an https directory, e.g. `https://updates.example.com/framecapt/win32/x64`, and build with `FRAMECAPT_UPDATE_URL` set to that directory. To get delta packages, also pass the previous feed as `remoteReleases` in `forge.config.ts` (then keep the previous `.nupkg` files in the feed).
2. **update.electronjs.org**, only for a **public** GitHub repository with published releases (not drafts): `FRAMECAPT_UPDATE_URL=https://update.electronjs.org/<owner>/<repo>/win32/<current version>`. The service is run by the Electron project and has its own limits (see its README).

Either way: updates only work for signed builds in practice (an unsigned update re-triggers SmartScreen), the app must be a Squirrel install, and **nothing calls `checkNow()` yet**: a settings toggle or menu item is a product decision for later. Privacy: a configured feed means the app contacts that host; update the About text and the privacy statement when that happens.

**OWNER ACTIONS**: choose and host a feed (or make the repository public), decide when the app checks, publish a privacy note.

## Owner actions that remain (summary)

- Confirm or replace the provisional identity: product name `FrameCapt`, publisher string `FrameCapt contributors`, app id `com.framecapt.app`, Squirrel package id `FrameCapt`, the icon (`assets/app/framecapt.ico`, the owner's logo), install folder name. Changing the Squirrel package id or the app id later breaks taskbar pins, notification grouping and in-place upgrades.
- Obtain a signing certificate; create the two secrets.
- Host an https icon (`iconUrl`) if a Programs and Features icon is wanted (it makes the installer contact that URL; `assets/app/framecapt.nuspectemplate` currently omits it on purpose).
- Choose and host an update feed; decide how updates are offered.
- Legal: GPL source offer for the bundled FFmpeg, third-party notices, H.264/AAC patent review (phase 11).
- Publish the draft release.
