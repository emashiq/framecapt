import type { ForgeConfig, ForgeConfigMaker } from '@electron-forge/shared-types';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerAppImage } from '@reforged/maker-appimage';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import packageJson from './package.json';

const VERSION = packageJson.version;
// Windows version resources need a numeric a.b.c.d FileVersion; a pre-release like 0.1.0-alpha.1
// keeps its full text in ProductVersion and gets FileVersion 0.1.0.<pre-release number>.
const [CORE_VERSION = VERSION, PRERELEASE = ''] = VERSION.split('-');
const BUILD_VERSION = `${CORE_VERSION}.${Number(PRERELEASE.match(/(\d+)$/)?.[1] ?? 0)}`;

// ---------------------------------------------------------------------------------------------
// PROVISIONAL IDENTITY. Everything below that names the product, the publisher or the install
// (app/Squirrel name, authors, company, app id, icon artwork) is a placeholder the owner must
// confirm or replace before any public release. See docs/release-process.md ("Owner actions").
// ---------------------------------------------------------------------------------------------
const PRODUCT_NAME = 'FrameCapt'; // PROVISIONAL
// Linux: lower-case executable and package name (/usr/bin/framecapt), the usual convention.
const LINUX_NAME = 'framecapt';
const IS_LINUX = process.platform === 'linux';
const HOMEPAGE = 'https://github.com/emashiq/framecapt'; // PROVISIONAL
const PUBLISHER = 'FrameCapt contributors'; // PROVISIONAL
const DESCRIPTION = 'FrameCapt - an offline, Windows-first screenshot and screen recording app.';

// ---------------------------------------------------------------------------------------------
// Code signing: optional, from the environment ONLY. No certificate is ever committed.
//   WINDOWS_CERTIFICATE_FILE      path to an Authenticode .pfx
//   WINDOWS_CERTIFICATE_PASSWORD  its password
//   WINDOWS_TIMESTAMP_SERVER      optional (default http://timestamp.digicert.com, read by
//                                 @electron/windows-sign)
// Both variables set: the packaged exe/dll/node files (Packager `windowsSign`) and the Squirrel
// Setup.exe/Update.exe (maker `windowsSign`) are signed with signtool. Otherwise the build is
// UNSIGNED, and says so below: Windows SmartScreen will warn when it is run.
// ---------------------------------------------------------------------------------------------
const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim();
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const windowsSign =
  certificateFile && certificatePassword
    ? { certificateFile, certificatePassword, description: PRODUCT_NAME }
    : undefined;
if (!windowsSign && (certificateFile || certificatePassword)) {
  throw new Error(
    'Code signing is half configured: set both WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD, or neither.',
  );
}
if (!IS_LINUX) {
  console.log(
    windowsSign
      ? `[framecapt] Windows code signing: ENABLED (certificate from WINDOWS_CERTIFICATE_FILE)`
      : '[framecapt] Windows code signing: DISABLED - this build is UNSIGNED (set WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD to sign)',
  );
}

/**
 * Copies the FFmpeg build of the target platform (`<vendor>/<platform>-<arch>`) to
 * `<package>/resources/ffmpeg/<platform>-<arch>`. `buildPath` is `<package>/resources/app`.
 */
export function copyFfmpegResource(
  vendorRoot: string,
  buildPath: string,
  platform: string,
  arch: string,
): void {
  const source = path.join(vendorRoot, `${platform}-${arch}`);
  if (!fs.existsSync(source)) {
    throw new Error(`FFmpeg for ${platform}-${arch} is missing: run "npm run fetch:ffmpeg".`);
  }
  fs.cpSync(source, path.join(path.dirname(buildPath), 'ffmpeg', `${platform}-${arch}`), {
    recursive: true,
  });
}

/**
 * Ships koffi (external to the Vite main bundle, ADR-052) as `<package>/resources/node_modules/koffi`
 * plus the prebuilt addon package of the target platform as
 * `<package>/resources/node_modules/@koromix/koffi-<platform>-<arch>`. The packaged app has no
 * node_modules inside app.asar, so `require('koffi')` from app.asar/.vite/build resolves it from
 * the resources folder, and koffi finds its addon in the sibling @koromix package. Only the files
 * koffi needs at run time are copied (no C++ sources, docs or vendored headers); the .node file is
 * outside the asar, where Windows can load it. `buildPath` is `<package>/resources/app`.
 */
export function copyKoffiResource(
  modulesRoot: string,
  buildPath: string,
  platform: string,
  arch: string,
): void {
  const addon = path.join(modulesRoot, '@koromix', `koffi-${platform}-${arch}`);
  if (!fs.existsSync(addon)) {
    throw new Error(
      `koffi for ${platform}-${arch} is missing: run "npm install" on that platform.`,
    );
  }
  const target = path.join(path.dirname(buildPath), 'node_modules');
  const skipDirs = new Set(['doc', 'vendor', 'lib', 'abi']);
  const runtimeFile = /(\.(cjs|js|json|node)|LICENSE\.txt)$/;
  const filter = (source: string): boolean => {
    const stat = fs.statSync(source);
    return stat.isDirectory()
      ? !skipDirs.has(path.basename(source))
      : runtimeFile.test(source) && !source.endsWith('.d.ts');
  };
  fs.cpSync(path.join(modulesRoot, 'koffi'), path.join(target, 'koffi'), {
    recursive: true,
    filter,
  });
  fs.cpSync(addon, path.join(target, '@koromix', `koffi-${platform}-${arch}`), {
    recursive: true,
    filter,
  });
}

/** The node_modules folder that holds koffi: the workspace root's (hoisted) or the app's own. */
function koffiModulesRoot(): string {
  return (
    [path.join(__dirname, 'node_modules'), path.join(__dirname, '..', '..', 'node_modules')].find(
      (candidate) => fs.existsSync(path.join(candidate, 'koffi', 'package.json')),
    ) ?? path.join(__dirname, 'node_modules')
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    name: PRODUCT_NAME,
    executableName: IS_LINUX ? LINUX_NAME : PRODUCT_NAME,
    // PROVISIONAL app id - owner must confirm before publication
    appBundleId: 'com.framecapt.app',
    buildVersion: BUILD_VERSION,
    // The owner's logo as an icon (assets/app/framecapt.ico, generated by npm run brand:assets).
    icon: 'assets/app/framecapt',
    win32metadata: {
      CompanyName: PUBLISHER, // PROVISIONAL
      FileDescription: DESCRIPTION,
      ProductName: PRODUCT_NAME,
      InternalName: PRODUCT_NAME,
      OriginalFilename: `${PRODUCT_NAME}.exe`,
      'requested-execution-level': 'asInvoker',
    },
    asar: true,
    // LICENSE (GPL-3.0) and THIRD_PARTY_NOTICES.md ship next to Electron's own license files. The
    // window icon PNG is Linux-only (Windows embeds the icon in the exe). The pinned FFmpeg build
    // is copied by the packageAfterCopy hook below (only the build of the platform being packaged).
    extraResource: [
      path.join(__dirname, '..', '..', 'LICENSE'),
      path.join(__dirname, '..', '..', 'THIRD_PARTY_NOTICES.md'),
      ...(IS_LINUX ? ['assets/brand/framecapt-logo-256.png'] : []),
    ],
    ...(windowsSign && { windowsSign }),
    // Pinned Electron zip checksum (from the official v44.5.1 release; the linux one is the GitHub release asset digest, 2026-10-03).
    // Builds are reproducible and work from the local cache without re-fetching SHASUMS256.txt.
    // Update together with the electron version in package.json.
    download: {
      checksums: {
        'electron-v44.5.1-win32-x64.zip':
          '9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db',
        'electron-v44.5.1-linux-x64.zip':
          '5bcd217611d6843ececd6c9e9c1fcd1da3ab066c43d8b1a9e4b44689a1fba6f5',
      },
    },
  },
  rebuildConfig: {},
  hooks: {
    // The pinned FFmpeg (npm run fetch:ffmpeg, run by the prepackage/premake/prestart hooks):
    // <resources>/ffmpeg/<platform>-<arch>/{ffmpeg,ffprobe}[.exe]. Only the folder of the target
    // platform is shipped: no Windows .exe in a Linux package and no Linux binary in a Windows one.
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      copyFfmpegResource(path.join(__dirname, 'vendor', 'ffmpeg'), buildPath, platform, arch);
      copyKoffiResource(koffiModulesRoot(), buildPath, platform, arch);
    },
    // Release guard: every package/make of a normal build is scanned for mock and test-hook code. A build made with the E2E switch set by mistake fails
    // here instead of shipping. The E2E build itself (package:e2e) is checked with --expect-mock.
    postPackage: async () => {
      if (process.env.FRAMECAPT_E2E_BUILD === '1') return;
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, 'scripts', 'check-no-mocks.mjs')],
        { cwd: __dirname, stdio: 'inherit', shell: false },
      );
      if (result.status !== 0) {
        throw new Error('check-no-mocks failed: the package contains mock or test-hook code.');
      }
    },
  },
  makers: [
    new MakerSquirrel({
      // The NuGet package id and the install folder (%LOCALAPPDATA%\FrameCapt). PROVISIONAL.
      name: PRODUCT_NAME,
      title: PRODUCT_NAME,
      authors: PUBLISHER, // PROVISIONAL
      description: DESCRIPTION,
      exe: `${PRODUCT_NAME}.exe`,
      // No spaces in the setup file name: safe in URLs, scripts and release assets.
      setupExe: `${PRODUCT_NAME}-Setup-${VERSION}.exe`,
      setupIcon: 'assets/app/framecapt.ico',
      // Shown by Setup.exe while it installs (interactive installs only; silent ones show nothing).
      loadingGif: 'assets/app/install-loading.gif',
      // No .msi: Squirrel's per-user Setup.exe is the installer (no admin rights, no UAC prompt).
      noMsi: true,
      // Squirrel downloads an iconUrl at install time (default: raw.githubusercontent.com), which
      // stalled an offline install for ~85 s. Our nuspec template has no iconUrl; Programs and
      // Features shows a generic icon until the owner hosts one (docs/release-process.md).
      nuspecTemplate: 'assets/app/framecapt.nuspectemplate',
      ...(windowsSign && { windowsSign }),
    }),
    // Portable zip: unzip anywhere and run FrameCapt.exe (no installer, no updates, no shortcuts).
    new MakerZIP({}, ['win32']),
    // Linux x64 (experimental): a .deb and an AppImage. Maintainer and homepage are PROVISIONAL.
    new MakerDeb({
      options: {
        name: LINUX_NAME,
        productName: PRODUCT_NAME,
        genericName: 'Screen Capture',
        description: DESCRIPTION,
        categories: ['Graphics', 'Utility', 'AudioVideo'],
        icon: 'assets/brand/framecapt-logo-512.png',
        maintainer: PUBLISHER, // PROVISIONAL
        homepage: HOMEPAGE, // PROVISIONAL
        section: 'graphics',
        bin: LINUX_NAME,
      },
    }),
    // @reforged/maker-appimage 5.3.1 is typed against maker-base 6/7 (platforms: string[]); it runs
    // under Forge 8 (verified by npm run make on Linux, docs/building-on-linux.md).
    new MakerAppImage({
      options: {
        name: LINUX_NAME,
        productName: PRODUCT_NAME,
        genericName: 'Screen Capture',
        categories: ['Graphics', 'Utility', 'AudioVideo'],
        icon: 'assets/brand/framecapt-logo-512.png',
        bin: LINUX_NAME,
        // The pinned, SHA-256-verified runtime (npm run make fetches it): without this option the
        // maker downloads the moving "continuous" release unchecked.
        runtime: path.join(__dirname, 'vendor', 'appimage-runtime', 'runtime-x86_64'),
      },
    }) as unknown as ForgeConfigMaker,
  ],
  plugins: [
    new VitePlugin({
      // Main and preload bundles are emitted as .cjs by the plugin.
      build: [
        { entry: { main: 'src/main/index.ts' }, config: 'vite.main.config.ts', target: 'main' },
        {
          entry: { preload: 'src/preload/index.ts' },
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // Secure fuse set. Note: Playwright cannot drive a packaged build because
    // EnableNodeCliInspectArguments is off; e2e runs against .vite/build instead.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // The renderer is served from app://framecapt, nothing loads from file:// (ADR-033, R-01), so
      // file:// pages do not need their extra privileges (fetch, service workers, ...).
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
