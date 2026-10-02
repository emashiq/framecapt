import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Framelet',
    executableName: 'Framelet',
    // PROVISIONAL app id — owner must confirm before publication
    appBundleId: 'com.framelet.app',
    asar: true,
    // The pinned FFmpeg build (npm run fetch:ffmpeg, run by the prepackage/premake/prestart hooks).
    // extraResource copies the folder by its name: <resources>/ffmpeg/win32-x64/{ffmpeg,ffprobe}.exe.
    extraResource: ['vendor/ffmpeg'],
    // Pinned Electron zip checksum (from the official v44.5.1 SHASUMS256.txt, verified 2026-10-02).
    // Builds are reproducible and work from the local cache without re-fetching SHASUMS256.txt.
    // Update together with the electron version in package.json.
    download: {
      checksums: {
        'electron-v44.5.1-win32-x64.zip':
          '9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db',
      },
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'framelet', setupExe: 'FrameletSetup.exe' }),
    new MakerZIP({}, ['win32']),
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
    }),
  ],
};

export default config;
