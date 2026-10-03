# Third-party notices

FrameCapt (c) the FrameCapt contributors is licensed under the GNU General Public License, version 3 only (see [LICENSE](LICENSE)). This file lists the third-party software that is shipped inside, or installed together with, the FrameCapt Windows build, with the licenses that require a notice. It was generated on 2026-10-02 from the dependency tree actually installed in this repository (`npx license-checker-rseidelsohn --production --json`: 53 packages plus the project itself) and from `vendor/ffmpeg/win32-x64/PROVENANCE.json`. Re-generate it whenever dependencies or the FFmpeg build change (see [docs/licensing.md](docs/licensing.md)).

This is an inventory, not legal advice. Nothing here is a statement of legal clearance.

## 1. Electron and Chromium

FrameCapt runs on Electron 44.5.1 (Chromium 152, Node.js 24.x), which is distributed under the MIT License (Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.). Chromium and the libraries it contains (V8, ANGLE, Skia, ICU and many more) carry their own licenses. The complete list with full texts is shipped by Electron as **`LICENSES.chromium.html`**, which sits next to `FrameCapt.exe` in the packaged app (verified in `out/FrameCapt-win32-x64/` on 2026-10-02). The Electron MIT text below is the `LICENSE` file Electron places there. Do not remove either file from a distribution.

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 2a. Linux x64 build (experimental): FFmpeg and the AppImage runtime

The experimental Linux packages (2026-10-03) bundle, instead of the Windows build below: **FFmpeg `n9.0.2-22-g46d8f462ee-20261001`**, the BtbN `linux64-gpl` static build (GPL-3.0-or-later: `--enable-gpl --enable-version3`, no `--enable-nonfree`; downloaded from https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz, SHA-256 `a6170faecf757381ad0338d7a6ba26e97c2ebe2b9c1568633421e15d1ed436a9`, source commit `46d8f462ee` of the `release/9.0` branch, build scripts https://github.com/BtbN/FFmpeg-Builds; full options in `resources/ffmpeg/linux-x64/PROVENANCE.json`), with the same Corresponding Source duty as below (OWNER-TASKS L1); and, in the AppImage only, the **AppImage type2-runtime** release `20251108` (MIT, https://github.com/AppImage/type2-runtime, SHA-256 `2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d`). The packaging tools (`@electron-forge/maker-deb`, `@reforged/maker-appimage`) are development dependencies and are not shipped.

## 2. FFmpeg (bundled program, GPL-3.0-or-later)

| Item                                | Value                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                             | `ffmpeg.exe` and `ffprobe.exe`, run as separate child processes (never linked into FrameCapt)                                                                                                                                                                                                                                                                                                                                            |
| Version                             | 9.0.2 ("ffmpeg version 9.0.2-essentials_build-www.gyan.dev")                                                                                                                                                                                                                                                                                                                                                                            |
| Built and distributed by            | Gyan Doshi, https://www.gyan.dev/ffmpeg/builds/ ("essentials" release, Windows x64, static)                                                                                                                                                                                                                                                                                                                                             |
| Downloaded from                     | https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip                                                                                                                                                                                                                                                                                                                                         |
| SHA-256 of the zip                  | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` (verified on every fetch by `scripts/fetch-ffmpeg.mjs`)                                                                                                                                                                                                                                                                                                              |
| License of this binary              | GPL version 3 or later: configured with `--enable-gpl --enable-version3` and **without** `--enable-nonfree` (checked from `ffmpeg -buildconf` and `ffmpeg -L` by the fetch script; the build's `LICENSE` is the GPLv3 text and its README says "License: GPL v3"; the publisher's page states "All builds are 64-bit, static and licensed as GPLv3", checked 2026-10-02)                                                                  |
| Source named by the build           | https://github.com/FFmpeg/FFmpeg/commit/946fcce07b (from the build's README.txt). On 2026-10-02 the GitHub API resolved this commit to `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, the commit the release tag `n9.0.2` points to                                                                                                                                                                                                          |
| Release tarball of the same version | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz (HTTP 200 on 2026-10-02)                                                                                                                                                                                                                                                                                                                                                                |
| Files shipped                       | `<resources>/ffmpeg/win32-x64/{ffmpeg.exe, ffprobe.exe, LICENSE, README.txt, PROVENANCE.json}`; the build's own GPLv3 `LICENSE` sits next to the executables                                                                                                                                                                                                                                                                            |

Build configuration of this binary (verbatim from `PROVENANCE.json`, field `buildConfiguration`; the build's README lists the same external libraries):

`--enable-gpl` `--enable-version3` `--enable-static` `--disable-w32threads` `--disable-autodetect` `--enable-cairo` `--enable-fontconfig` `--enable-iconv` `--enable-gnutls` `--enable-libxml2` `--enable-gmp` `--enable-bzlib` `--enable-lzma` `--enable-zlib` `--enable-libsrt` `--enable-libssh` `--enable-libzmq` `--enable-avisynth` `--enable-sdl2` `--enable-libwebp` `--enable-libx264` `--enable-libx265` `--enable-libxvid` `--enable-libaom` `--enable-libopenjpeg` `--enable-libvpx` `--enable-mediafoundation` `--enable-libass` `--enable-libfreetype` `--enable-libfribidi` `--enable-libharfbuzz` `--enable-libvidstab` `--enable-libvmaf` `--enable-libzimg` `--enable-amf` `--enable-cuda-llvm` `--enable-cuvid` `--enable-dxva2` `--enable-d3d11va` `--enable-d3d12va` `--enable-ffnvcodec` `--enable-libvpl` `--enable-nvdec` `--enable-nvenc` `--enable-vaapi` `--enable-openal` `--enable-libgme` `--enable-libopenmpt` `--enable-libopencore-amrwb` `--enable-libmp3lame` `--enable-libtheora` `--enable-libvo-amrwbenc` `--enable-libgsm` `--enable-libopencore-amrnb` `--enable-libopus` `--enable-libspeex` `--enable-libvorbis` `--enable-librubberband`

Among these, FrameCapt actually uses libx264 (H.264 encoder for MP4 export), the native `aac` encoder, and the demuxers/muxers for WebM and MP4 (stream copy of VP9/Opus for finalization). The other libraries (libx265, libaom, libmp3lame, and so on) are present in the binary but not used by FrameCapt. Each library has its own license (for example x264 and x265 are GPL, others are BSD-style, ISC or LGPL); the combined binary is GPL-3.0-or-later.

### Source-code obligation (GPLv3 section 6)

Anyone who distributes the FrameCapt installer or portable zip also distributes this FFmpeg binary and must provide the **Corresponding Source** of that exact binary: with the binary, through a written offer valid for at least three years (or as long as support or spare parts are offered), or from a network location kept available while the binaries are distributed. Pointing to the upstream FFmpeg tarball is a starting point, not the whole answer, because the binary is a Gyan build that statically contains the external libraries above (their sources, and the build scripts used, belong to the Corresponding Source).

**OWNER TASK: mirror the exact sources alongside each binary release** (the FFmpeg 9.0.2 source above, the sources of the statically linked libraries, and Gyan's build scripts, or switch to an FFmpeg build whose publisher provides a complete source package for that exact binary) and add the written-offer text, with a contact, to the release notes and download page. Until that is done, do not publish a binary release. See [docs/OWNER-TASKS.md](docs/OWNER-TASKS.md).

Codec and patent questions about H.264, AAC, VP9 and Opus are a separate open review item (see [docs/licensing.md](docs/licensing.md)); this file does not address them.

## 3. Squirrel.Windows (installer)

The installer (`FrameCapt-Setup-<version>.exe`) and `Update.exe` are produced with electron-winstaller 5.4.4 (MIT), which vendors Squirrel.Windows (MIT License, https://github.com/Squirrel/Squirrel.Windows). Its vendor folder also contains tools such as 7-Zip and NuGet. The exact third-party contents and license notices of the installer stub were **not inventoried** in this pass. **OPEN ITEM:** inspect `node_modules/electron-winstaller/vendor` and the built `Setup.exe` / `Update.exe` and add any notices that apply before a public release (7-Zip, for example, is LGPL-2.1-or-later with an unRAR restriction; verify what is actually redistributed).

## 4. Inter typeface (SIL Open Font License 1.1)

The renderer bundles the variable Inter font through `@fontsource-variable/inter` 5.3.0 (Copyright 2016 The Inter Project Authors, https://github.com/rsms/inter) as WOFF2 files, under the SIL Open Font License 1.1. The full OFL text is in section 6 (the group containing `@fontsource-variable/inter`). The OFL allows bundling with other software, including GPL software, as long as the font is not sold by itself; the font files stay under the OFL.

## 5. npm packages bundled into the renderer

The renderer is bundled with Vite. The packages below are the production dependency tree (direct dependencies: react, react-dom, @radix-ui/react-alert-dialog, @radix-ui/react-dropdown-menu, @radix-ui/react-tooltip, lucide-react, sonner, zod, @fontsource-variable/inter). `@types/react`, `@types/react-dom` and `csstype` are type declarations only (no runtime code). All are MIT unless the table says otherwise; ISC, 0BSD and OFL-1.1 are permissive and GPL-3.0-compatible. No GPL-incompatible, copyleft or unknown license was found among these 53 packages. One package (`react-remove-scroll-bar`) declares MIT but ships no license file.

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| @floating-ui/core | 1.8.0 | MIT | https://github.com/floating-ui/floating-ui |
| @floating-ui/dom | 1.8.0 | MIT | https://github.com/floating-ui/floating-ui |
| @floating-ui/react-dom | 2.1.9 | MIT | https://github.com/floating-ui/floating-ui |
| @floating-ui/utils | 0.2.12 | MIT | https://github.com/floating-ui/floating-ui |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 | https://github.com/fontsource/font-files |
| @radix-ui/primitive | 1.1.7 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-alert-dialog | 1.1.23 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-arrow | 1.1.15 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-collection | 1.1.15 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-context | 1.2.2 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-dialog | 1.1.23 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-direction | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-dismissable-layer | 1.1.19 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-dropdown-menu | 2.1.24 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-focus-guards | 1.1.6 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-focus-scope | 1.1.16 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-id | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-menu | 2.1.24 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-popper | 1.3.7 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-portal | 1.1.17 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-presence | 1.1.10 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-primitive | 2.1.10 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-roving-focus | 1.1.19 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-slot | 1.3.3 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-tooltip | 1.2.16 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-is-hydrated | 0.1.3 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-rect | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-use-size | 1.1.4 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/react-visually-hidden | 1.2.11 | MIT | https://github.com/radix-ui/primitives |
| @radix-ui/rect | 1.1.3 | MIT | https://github.com/radix-ui/primitives |
| @types/react-dom | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| aria-hidden | 1.2.6 | MIT | https://github.com/theKashey/aria-hidden |
| csstype | 3.2.3 | MIT | https://github.com/frenic/csstype |
| detect-node-es | 1.1.0 | MIT | https://github.com/thekashey/detect-node |
| get-nonce | 1.0.1 | MIT | https://github.com/theKashey/get-nonce |
| lucide-react | 1.49.0 | ISC | https://github.com/lucide-icons/lucide |
| react-dom | 19.3.0 | MIT | https://github.com/react/react |
| react-remove-scroll-bar | 2.3.8 | MIT | https://github.com/theKashey/react-remove-scroll-bar |
| react-remove-scroll | 2.7.2 | MIT | https://github.com/theKashey/react-remove-scroll |
| react-style-singleton | 2.2.3 | MIT | https://github.com/theKashey/react-style-singleton |
| react | 19.3.0 | MIT | https://github.com/react/react |
| scheduler | 0.28.0 | MIT | https://github.com/react/react |
| sonner | 2.0.8 | MIT | https://github.com/emilkowalski/sonner |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib |
| use-callback-ref | 1.3.3 | MIT | https://github.com/theKashey/use-callback-ref |
| use-sidecar | 1.1.3 | MIT | https://github.com/theKashey/use-sidecar |
| zod | 4.6.5 | MIT | https://github.com/colinhacks/zod |


Development-only tooling (Electron Forge, Vite, TypeScript, ESLint, Playwright, Vitest, Tailwind and so on) is not shipped to users and is not listed.

Brand assets: the FrameCapt logo and the files generated from it (the application icon `assets/app/framecapt.ico`, `assets/app/install-loading.gif`, the tray icons in `assets/tray/`, the UI logo images) are owner-supplied brand artwork, (c) Ashiqur Rahman Emran, generated by `scripts/generate-brand-assets.mjs`. They are **not** licensed under the GPL that covers the code: the name and logo are reserved unless the owner decides otherwise (see [docs/licensing.md](docs/licensing.md), section 1a). No third-party icon files are included. The lucide-react icons used in the UI are covered by the lucide-react license text below.

## 6. License texts for the npm packages

Packages whose license files have identical text are grouped.

### 1. @floating-ui/core@1.8.0, @floating-ui/dom@1.8.0, @floating-ui/react-dom@2.1.9, @floating-ui/utils@0.2.12

```text
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 2. @fontsource-variable/inter@5.3.0

```text
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### 3. @radix-ui/primitive@1.1.7, @radix-ui/react-alert-dialog@1.1.23, @radix-ui/react-arrow@1.1.15, @radix-ui/react-collection@1.1.15, @radix-ui/react-compose-refs@1.1.5, @radix-ui/react-context@1.2.2, @radix-ui/react-dialog@1.1.23, @radix-ui/react-direction@1.1.4, @radix-ui/react-dismissable-layer@1.1.19, @radix-ui/react-dropdown-menu@2.1.24, @radix-ui/react-focus-guards@1.1.6, @radix-ui/react-focus-scope@1.1.16, @radix-ui/react-id@1.1.4, @radix-ui/react-menu@2.1.24, @radix-ui/react-popper@1.3.7, @radix-ui/react-portal@1.1.17, @radix-ui/react-presence@1.1.10, @radix-ui/react-primitive@2.1.10, @radix-ui/react-roving-focus@1.1.19, @radix-ui/react-slot@1.3.3, @radix-ui/react-tooltip@1.2.16, @radix-ui/react-use-callback-ref@1.1.4, @radix-ui/react-use-controllable-state@1.2.6, @radix-ui/react-use-effect-event@0.0.5, @radix-ui/react-use-is-hydrated@0.1.3, @radix-ui/react-use-layout-effect@1.1.4, @radix-ui/react-use-rect@1.1.4, @radix-ui/react-use-size@1.1.4, @radix-ui/react-visually-hidden@1.2.11, @radix-ui/rect@1.1.3

```text
MIT License

Copyright (c) 2022 WorkOS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4. @types/react-dom@19.3.0, @types/react@19.3.0

```text
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

### 5. aria-hidden@1.2.6, react-remove-scroll@2.7.2, react-style-singleton@2.2.3, use-callback-ref@1.3.3, use-sidecar@1.1.3

```text
MIT License

Copyright (c) 2017 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 6. csstype@3.2.3

```text
Copyright (c) 2017-2018 Fredrik Nicol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 7. detect-node-es@1.1.0

```text
MIT License

Copyright (c) 2017 Ilya Kantor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 8. get-nonce@1.0.1

```text
MIT License

Copyright (c) 2020 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 9. lucide-react@1.49.0

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 10. react-dom@19.3.0, react@19.3.0, scheduler@0.28.0

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 11. react-remove-scroll-bar@2.3.8

This package declares its license (MIT) in package.json and README but ships no license file; its copyright holder is the author named in its package.json (Anton Korzunov). The MIT License text is the one reproduced for the sibling packages by the same author in this file.

### 12. sonner@2.0.8

```text
MIT License

Copyright (c) 2023 Emil Kowalski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 13. tslib@2.8.1

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### 14. zod@4.6.5

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

