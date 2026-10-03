# FFmpeg

FrameCapt finishes every recording with FFmpeg (`-c copy` remux, probing, recovery) and converts recordings to MP4 on request (H.264 + AAC, phase 07). FFmpeg is a **local child process**, started per job with `shell: false` and an argument array, never a server and never found through `PATH`.

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

FrameCapt is proposed as GPL-3.0-only and runs FFmpeg as a separate program, so this is compatible; the exact FFmpeg source, build options and license must still be part of the third-party notices (phase 11), and the GPL requires offering the corresponding source of the FFmpeg binary that is redistributed (the commit above, and a written offer or hosted copy, are release tasks for the owner). Other FFmpeg builds have other licenses (an LGPL-only build, for example, would have no libx264); do not swap builds without redoing this section.

Build configuration summary (full list in `PROVENANCE.json`, field `buildConfiguration`): static, gcc 16.2.0 (MSYS2), `--disable-autodetect`; libvpx, libaom, libx264, libx265, libxvid, libopus, libvorbis, libmp3lame, libwebp and others; hardware paths (NVENC, AMF, QSV via libvpl, D3D11/D3D12VA); no `--enable-nonfree`.

Codec and patent review for the codecs inside (x264/x265/AAC-related) is an owner action before a commercial release; nothing here is legal clearance. Phase 06 only used stream copy for WebM (VP9/Opus). Since phase 07 the MP4 export encodes H.264 (libx264) and AAC: H.264 and AAC may carry patent licensing obligations in some jurisdictions (patent pool terms, for example, can apply to distributing or selling an H.264/AAC encoder or content), and libx264 is GPL code that is part of this GPL-3.0-or-later build. **Owner review is required before a commercial release; this document does not assert that any of it is cleared.** If the review says no, the product can ship without MP4 export: the capability check below simply reports it unavailable, and WebM stays the deliverable.

## What FrameCapt runs

All calls are in `src/main/media/ffmpeg.ts`; the binary paths come from `resolveFfmpeg()`:

- packaged: `process.resourcesPath/ffmpeg/win32-x64/{ffmpeg,ffprobe}.exe`
- development: `<repo>/vendor/ffmpeg/win32-x64/{ffmpeg,ffprobe}.exe`
- missing: typed error `FFMPEG_MISSING` ("Run npm run fetch:ffmpeg"). A recording refuses to start without it (the file could not be finished), and the startup self-check logs `ffmpeg ok <version line>` or an error to `main.log`.

Calls (every one an argument array, `shell: false`, `windowsHide: true`, `stdio: ['ignore','pipe','pipe']`, abort and timeout kill the process tree with `taskkill /T /F`):

```
ffmpeg -hide_banner -nostats -progress pipe:1 -y -i <stream.webm> -c copy -map 0 -f webm <partial>
ffprobe -v error -show_streams -show_format -of json <file>
ffmpeg -hide_banner -version
ffmpeg -hide_banner -encoders                      (once at startup: are libx264 and aac there?)
ffmpeg -hide_banner -v error -y -ss <t> -i <recording> -frames:v 1 -vf scale=min(480\,iw):-2 <thumb>.partial.png
ffmpeg <MP4 export command, below>
```

stderr is kept as a 64 KB tail in memory (and written to `finalize.log` in a failed session). The JSON of ffprobe is validated with zod before use.

## MP4 export (phase 07)

Code: `src/main/media/export.ts` (`detectMp4Capability`, `mp4Args`, `exportMp4`, `verifyMp4`), jobs in `src/main/history/export-service.ts`.

```
ffmpeg -hide_banner -y -i <source.webm> -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -crf 20
       -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -b:a 160k
       -movflags +faststart -progress pipe:1 -nostats <dir>/.framecapt-export-<random>.partial.mp4
```

| Piece                                               | Why                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-map 0:v:0 -map 0:a:0?`                            | The first video stream and the first audio stream if there is one (a silent recording stays silent). Nothing else is copied                                              |
| `libx264 -preset veryfast -crf 20 -pix_fmt yuv420p` | A fast, near-transparent H.264 that every player and browser plays (4:2:0, 8 bit). `veryfast` was chosen for speed; 6 s of 1920x804 + audio took 0.9 s on the host       |
| `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2`             | 4:2:0 needs even sides; an odd side is rounded DOWN by at most one pixel (641x361 became 640x360 in the test)                                                            |
| `aac -b:a 160k`                                     | FFmpeg's native AAC-LC encoder (`aac`), not the Media Foundation one (`aac_mf`), so the result does not depend on the Windows version                                    |
| `-movflags +faststart`                              | The `moov` index is moved in front of `mdat`; the file plays while it downloads and previews quickly. Verified by reading the top-level boxes (`ftyp, moov, free, mdat`) |
| `-progress pipe:1 -nostats`                         | Machine-readable progress: percent = `out_time` / the source's probed duration, capped at 99 until the output was verified                                               |

Every flag was run against the bundled 9.0.2 build (the integration tests and the native test use the real binary; each produced a clean H.264 + AAC file). The default frame-rate handling (variable frame rate in, constant out) was kept: the 6 s native recording came out within 0.005 s of the source length.

**Capability.** MP4 is offered only if `ffmpeg -hide_banner -encoders` lists both `libx264` and `aac`. The result is cached for the run. Otherwise the UI shows "MP4 export needs an FFmpeg build with H.264 — your recording is saved as WebM", the `export:mp4` channel refuses, and nothing is produced. A WebM is never renamed to `.mp4`.

**Safety.** The output is written to a partial file next to the destination (same volume, atomic rename), probed (`mov,mp4` container, `h264`, `aac` when the source had audio, duration within 0.5 s of the source) and only then renamed onto the destination the user chose (the save dialog already asked about overwriting). On cancel, timeout (max(10 min, 4x the duration)), failure or a failed check, the partial file is removed (with retries: Windows keeps a killed process's file open for a moment) and the original is untouched (SHA-256 compared in the tests). The partial name carries 6 random bytes, so a user file can never be mistaken for it. There is one export at a time.

**Measured** (host: Ryzen 7 7700, FFmpeg 9.0.2; `docs/evidence/phase07/export-integration.json`, `export-native.json`): a 4 s 640x360 VP9 + Opus test file exports in 0.18 s to 595 KB; a real 6.07 s 1920x804 screen recording with system audio exports in 0.89 s (6.9x real time) from 1.07 MB to 281 KB, H.264 yuv420p + AAC, duration 6.067 s, fast start, and a full decode with `ffmpeg -v error -i out.mp4 -f null -` exits 0 with empty stderr; a 40 s 1080p test file cancelled at 38 % after 1.7 s left the original byte-identical, no partial file and no running ffmpeg, and the retry completed (40.0 s).

## Fetching and updating

`npm run fetch:ffmpeg` (`scripts/fetch-ffmpeg.mjs`): downloads the zip, verifies the SHA-256 (mismatch: abort, delete the download, leave any existing install untouched), extracts only the four files above with a built-in zip reader (`node:zlib`; no Python, no PowerShell, no third-party code), writes `PROVENANCE.json` (`url, sha256, version, versionLine, fetchedAt, buildConfiguration[], license`) and re-verifies the license claim. It is **idempotent**: when the four files exist and `PROVENANCE.json` has the same SHA-256 it does nothing (about 0.4 s).

It runs automatically from npm hooks: `prestart`, `prepackage` (so also `package`, `test:native`), `prepackage:e2e` (so `test:e2e`) and `premake`. The hook route was chosen over a Forge `generateAssets` hook because `package:e2e` runs Forge through a script and the npm hooks cover every entry point the same way, visibly, with no Forge-specific code.

To update FFmpeg: pick a release at https://github.com/GyanD/codexffmpeg/releases, download it once, compute `sha256sum`, change `version`, `url`, `sha256` and `root` in `scripts/fetch-ffmpeg.mjs`, run `npm run fetch:ffmpeg`, read the new `PROVENANCE.json` (license line, `--enable-nonfree` absent, `-L` text), run `npm test` (the real-ffmpeg integration tests), `npm run test:e2e` and `npm run test:native`, then update this file and the third-party notices.

## Packaging

`forge.config.ts` sets `packagerConfig.extraResource: ['vendor/ffmpeg']`. Electron Packager copies an extra resource into `resources/` under its own **base name**, so the result is `resources/ffmpeg/win32-x64/ffmpeg.exe` (not `resources/ffmpeg/ffmpeg.exe`); `resolveFfmpeg()` uses that exact layout. Verified: `out/FrameCapt-win32-x64/resources/ffmpeg/win32-x64/{ffmpeg.exe,ffprobe.exe,LICENSE,PROVENANCE.json,README.txt}` exist after `npm run package`, and the packaged exe logs `ffmpeg ok ...` on start (see docs/recording-persistence.md, "Verification").

## Linux x64 build (experimental, 2026-10-03)

| Item                | Value                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version             | `n9.0.2-22-g46d8f462ee-20261001`: the `release/9.0` branch, 9.0.2 plus 22 commits (git `46d8f462ee`). Closest published static Linux GPL build to the Windows 9.0.2                                     |
| Distributor         | BtbN/FFmpeg-Builds, `linux64-gpl` static build, GitHub release `autobuild-2026-10-01-13-06`                                                                                                             |
| URL                 | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz                                                                  |
| SHA-256 of the file | `a6170faecf757381ad0338d7a6ba26e97c2ebe2b9c1568633421e15d1ed436a9` (the GitHub API `digest` of the asset, 151,030,404 bytes; verified by the fetch script)                                              |
| Extracted           | `bin/ffmpeg` (172,705,032 B), `bin/ffprobe` (172,479,688 B), `LICENSE.txt` (saved as `LICENSE`, 35,147 B); `ffplay`, docs, presets are not extracted. Executable bits are set by the script             |
| License             | GPL-3.0-or-later: `-buildconf` has `--enable-gpl --enable-version3` and no `--enable-nonfree`; `ffmpeg -L` reports GPL version 3 or later (checked by `fetch-ffmpeg.mjs`, written to `PROVENANCE.json`) |
| Location            | `vendor/ffmpeg/linux-x64/` (dev), `<resources>/ffmpeg/linux-x64/` (packaged)                                                                                                                            |

`scripts/fetch-ffmpeg.mjs` picks the target from `process.platform`/`process.arch` (`win32-x64` zip, `linux-x64` tar.xz extracted with the system `tar` through an argument array). `resolveFfmpeg()` uses `<platform>-<arch>` and `.exe` names only on Windows. Other platforms (macOS, arm64): nothing is pinned, the script does nothing and the app reports FFMPEG_MISSING.

**BtbN autobuild tags are not permanent** (the project deletes old ones): a tag can disappear and break the pinned URL. OWNER TASK: mirror this exact tarball (and, for GPLv3 section 6, the corresponding sources and the build scripts at https://github.com/BtbN/FFmpeg-Builds) next to every Linux binary release and then point `url` at the mirror; the SHA-256 stays. See [OWNER-TASKS.md](OWNER-TASKS.md).

The build contains encoders FrameCapt does not use and network protocols (libzmq, libssh, libsrt, librist, openssl). They are unreachable from the app: every input is opened with `-protocol_whitelist file` and absolute paths (S-02, [security-review.md](security-review.md)).

Verified on Linux: the unit suite incl. the real-ffmpeg integration tests (finalize, recover, MP4 export, abort kills the process) passes against this build; the packaged app logs `ffmpeg ok ffmpeg version n9.0.2-22-g46d8f462ee-20261001`.
