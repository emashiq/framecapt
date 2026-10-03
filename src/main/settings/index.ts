import { app, nativeTheme } from 'electron';
import type { EffectiveSettings, Settings } from '../../shared/settings';
import { defaultMediaFolders, setAutostart } from '../linux';
import { log } from '../logger';
import { loginItemOptions } from './login-item';
import { resolveOutputDirs } from './output-dirs';
import type { SettingsStore } from './store';

/** The settings plus what main derives from them: the folders in use. */
export interface AppSettings {
  store: SettingsStore;
  /** The screenshot and recording folders now in effect (the chosen ones, else the defaults). */
  dirs(): EffectiveSettings;
}

export function createAppSettings(store: SettingsStore): AppSettings {
  return {
    store,
    dirs: () =>
      resolveOutputDirs(
        store.get(),
        defaultMediaFolders((name) => app.getPath(name)),
      ),
  };
}

/**
 * Applies what is not just read on demand: the theme (every window follows it through
 * `prefers-color-scheme`, which `nativeTheme.themeSource` overrides) and the login item. The login
 * item is only written when the user changes it (never at startup: opt-in, off by default), and
 * only by a packaged build: an unpackaged run would register the bare Electron binary.
 */
export function watchSettings(store: SettingsStore): void {
  nativeTheme.themeSource = store.get().general.theme;
  let launchAtLogin = store.get().general.launchAtLogin;
  let theme = store.get().general.theme;
  store.onChange((settings: Settings) => {
    if (settings.general.theme !== theme) {
      theme = settings.general.theme;
      nativeTheme.themeSource = theme;
    }
    if (settings.general.launchAtLogin !== launchAtLogin) {
      launchAtLogin = settings.general.launchAtLogin;
      applyLoginItem(launchAtLogin);
    }
  });
}

export function applyLoginItem(openAtLogin: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux')
    return;
  if (!app.isPackaged) {
    log.info(`Launch at login ${openAtLogin ? 'on' : 'off'}: not applied by an unpackaged build`);
    return;
  }
  try {
    if (process.platform === 'linux') {
      // Electron has no login item on Linux: an XDG autostart entry does the same.
      setAutostart(openAtLogin, { ...process.env, execPath: process.execPath });
    } else {
      app.setLoginItemSettings(loginItemOptions(openAtLogin, { execPath: process.execPath }));
    }
    log.info(`Launch at login ${openAtLogin ? 'enabled' : 'disabled'}`);
  } catch (error) {
    log.warn(`Launch at login could not be changed: ${String(error)}`);
  }
}
