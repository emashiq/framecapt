# FFmpeg

Framelet finishes every recording with FFmpeg (`-c copy` remux, probing, recovery). FFmpeg is a **local child process**, started per job with `shell: false` and an argument array, never a server and never found through `PATH`.

## The pinned build

| Item                | Value                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Version             | 9.0.2 (`ffmpeg version 9.0.2-essentials_build-www.gyan.dev`)                                                                           |
| Distributor         | gyan.dev "essentials" Windows x64 static build, mirrored as a GitHub release by the same author                                        |
| URL                 | https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip                                         |
| SHA-256 of the zip  | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` (verified by the fetch script, 114,768,076 bytes)                   |
| Source code         | https://github.com/FFmpeg/FFmpeg/commit/946fcce07b (named in the build's README.txt)                                                   |
| Extracted           | `ffmpeg.exe` (105,423,872 B), `ffprobe.exe` (105,221,120 B), `LICENSE`, `README.txt`. `ffplay.exe`, docs and presets are NOT extracted |
| Location (dev)      | `vendor/ffmpeg/win32-x64/` (gitignored), plus `PROVENANCE.json` written by the script                                                  |
| Location (packaged) | `<resources>/ffmpeg/win32-x64/` (see "Packaging")                                                                                      |

Size note: both executables are about 105 MB each (static builds), so an installer carries about 211 MB of FFmpeg before compression (about 75 MB compressed in the original zip). A smaller custom build is a later optimization, not a phase 06 goal.

## License (verified from the binary, not assumed)

`ffmpeg.exe -hide_banner -buildconf` starts with `--enable-gpl --enable-version3 --enable-static ...` and contains **no** `--enable-nonfree`. `ffmpeg.exe -L` prints "ffmpeg is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 3 of the License, or (at your option) any later version." The zip's `LICENSE` file is the GPL version 3 text and its README says "License: GPL v3". Conclusion: this binary is **GPL-3.0-or-later** (GPL because of `--enable-gpl` libraries such as libx264/libx265; version 3 because of `--enable-version3`). `scripts/fetch-ffmpeg.mjs` re-checks all of this on every fetch and refuses a build that is non-free, not GPL/version 3, or whose `-L` text differs.

Framelet is proposed as GPL-3.0-only and runs FFmpeg as a separate program, so this is compatible; the exact FFmpeg source, build options and license must still be part of the third-party notices (phase 11), and the GPL requires offering the corresponding source of the FFmpeg binary that is redistributed (the commit above, and a written offer or hosted copy, are release tasks for the owner). Other FFmpeg builds have other licenses (an LGPL-only build, for example, would have no libx264); do not swap builds without redoing this section.

Build configuration summary (full list in `PROVENANCE.json`, field `buildConfiguration`): static, gcc 16.2.0 (MSYS2), `--disable-autodetect`; libvpx, libaom, libx264, libx265, libxvid, libopus, libvorbis, libmp3lame, libwebp and others; hardware paths (NVENC, AMF, QSV via libvpl, D3D11/D3D12VA); no `--enable-nonfree`.

Codec and patent review for the codecs inside (x264/x265/AAC-related) is an owner action before a commercial release; nothing here is legal clearance. Phase 06 itself only uses stream copy for WebM (VP9/Opus), no encoder.

## What Framelet runs

All calls are in `src/main/media/ffmpeg.ts`; the binary paths come from `resolveFfmpeg()`:

- packaged: `process.resourcesPath/ffmpeg/win32-x64/{ffmpeg,ffprobe}.exe`
- development: `<repo>/vendor/ffmpeg/win32-x64/{ffmpeg,ffprobe}.exe`
- missing: typed error `FFMPEG_MISSING` ("Run npm run fetch:ffmpeg"). A recording refuses to start without it (the file could not be finished), and the startup self-check logs `ffmpeg ok <version line>` or an error to `main.log`.

Calls (every one an argument array, `shell: false`, `windowsHide: true`, `stdio: ['ignore','pipe','pipe']`, abort and timeout kill the process tree with `taskkill /T /F`):

```
ffmpeg -hide_banner -nostats -progress pipe:1 -y -i <stream.webm> -c copy -map 0 -f webm <partial>
ffprobe -v error -show_streams -show_format -of json <file>
ffmpeg -hide_banner -version
```

stderr is kept as a 64 KB tail in memory (and written to `finalize.log` in a failed session). The JSON of ffprobe is validated with zod before use.

## Fetching and updating

`npm run fetch:ffmpeg` (`scripts/fetch-ffmpeg.mjs`): downloads the zip, verifies the SHA-256 (mismatch: abort, delete the download, leave any existing install untouched), extracts only the four files above with a built-in zip reader (`node:zlib`; no Python, no PowerShell, no third-party code), writes `PROVENANCE.json` (`url, sha256, version, versionLine, fetchedAt, buildConfiguration[], license`) and re-verifies the license claim. It is **idempotent**: when the four files exist and `PROVENANCE.json` has the same SHA-256 it does nothing (about 0.4 s).

It runs automatically from npm hooks: `prestart`, `prepackage` (so also `package`, `test:native`), `prepackage:e2e` (so `test:e2e`) and `premake`. The hook route was chosen over a Forge `generateAssets` hook because `package:e2e` runs Forge through a script and the npm hooks cover every entry point the same way, visibly, with no Forge-specific code.

To update FFmpeg: pick a release at https://github.com/GyanD/codexffmpeg/releases, download it once, compute `sha256sum`, change `version`, `url`, `sha256` and `root` in `scripts/fetch-ffmpeg.mjs`, run `npm run fetch:ffmpeg`, read the new `PROVENANCE.json` (license line, `--enable-nonfree` absent, `-L` text), run `npm test` (the real-ffmpeg integration tests), `npm run test:e2e` and `npm run test:native`, then update this file and the third-party notices.

## Packaging

`forge.config.ts` sets `packagerConfig.extraResource: ['vendor/ffmpeg']`. Electron Packager copies an extra resource into `resources/` under its own **base name**, so the result is `resources/ffmpeg/win32-x64/ffmpeg.exe` (not `resources/ffmpeg/ffmpeg.exe`); `resolveFfmpeg()` uses that exact layout. Verified: `out/Framelet-win32-x64/resources/ffmpeg/win32-x64/{ffmpeg.exe,ffprobe.exe,LICENSE,PROVENANCE.json,README.txt}` exist after `npm run package`, and the packaged exe logs `ffmpeg ok ...` on start (see docs/recording-persistence.md, "Verification").
