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
