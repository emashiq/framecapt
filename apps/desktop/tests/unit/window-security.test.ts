/**
 * Window and session hardening, as configured in main: the preferences every FrameCapt window gets
 * and the policies installed on the session (navigation, permissions, devices, network). Electron
 * is replaced by recorders; what matters is what the app asks Electron to do.
 */
import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  created: [] as ((event: unknown, contents: unknown) => void)[],
  isPackaged: { value: false },
  windows: [] as { options: Record<string, unknown>; menuRemoved: boolean; url: string }[],
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return hoisted.isPackaged.value;
    },
    on: (event: string, listener: (event: unknown, contents: unknown) => void) => {
      if (event === 'web-contents-created') hoisted.created.push(listener);
    },
    getPath: () => '/nonexistent',
    getAppPath: () => '/app',
  },
  BrowserWindow: class {
    webContents = { id: 41, once: () => undefined, isDestroyed: () => false };
    record = { options: {} as Record<string, unknown>, menuRemoved: false, url: '' };
    constructor(options: Record<string, unknown>) {
      this.record.options = options;
      hoisted.windows.push(this.record);
    }
    on() {}
    once() {}
    removeMenu() {
      this.record.menuRemoved = true;
    }
    loadURL(url: string) {
      this.record.url = url;
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
  },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined, off: () => undefined },
  screen: { getAllDisplays: () => [] },
  webContents: {},
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import {
  installNavigationLockdown,
  installNetworkBlocker,
  installPermissionHandlers,
} from '../../src/main/security';
import type { AppOriginConfig } from '../../src/main/app-origin';
import type { Role } from '../../src/shared/types';
import { createEditorWindow, getRole, securePreferences } from '../../src/main/windows';

const config: AppOriginConfig = {};

describe('securePreferences: what every window gets', () => {
  it('isolated, sandboxed, no Node, web security on, nothing insecure allowed', () => {
    hoisted.isPackaged.value = true;
    const preferences = securePreferences();
    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: false, // packaged builds have no DevTools
    });
    expect(preferences.preload).toMatch(/preload\.cjs$/);
    // None of the risky switches is ever turned on (their defaults are off in Electron 44).
    for (const risky of [
      'nodeIntegrationInWorker',
      'nodeIntegrationInSubFrames',
      'experimentalFeatures',
      'enableRemoteModule',
      'contextIsolation_off',
    ]) {
      expect(preferences).not.toHaveProperty(risky, true);
    }
  });

  it('DevTools only exist in unpackaged development runs', () => {
    hoisted.isPackaged.value = false;
    expect(securePreferences().devTools).toBe(true);
    hoisted.isPackaged.value = true;
    expect(securePreferences().devTools).toBe(false);
  });
});

describe('the Editor window', () => {
  it('gets the secure preferences, its own role and no default menu', () => {
    hoisted.isPackaged.value = true;
    const win = createEditorWindow();
    const { options, menuRemoved, url } = hoisted.windows.at(-1) ?? {
      options: {},
      menuRemoved: false,
      url: '',
    };
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    });
    expect(options).toMatchObject({ show: false, minWidth: 900, minHeight: 600 });
    // The app's own origin and the editor's hash: nothing remote, nothing from file://.
    expect(url).toMatch(/^(app:\/\/framecapt\/|http:\/\/localhost)[^#]*#\/editor$/);
    expect(menuRemoved).toBe(true);
    expect(getRole(win.webContents.id)).toBe('editor');
  });
});

describe('navigation lockdown (every webContents)', () => {
  function contents() {
    const handlers = new Map<
      string,
      (event: { preventDefault: () => void }, ...rest: unknown[]) => void
    >();
    let openHandler: ((details: { url: string }) => { action: string }) | undefined;
    return {
      handlers,
      on: (
        name: string,
        handler: (event: { preventDefault: () => void }, ...rest: unknown[]) => void,
      ) => handlers.set(name, handler),
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
        openHandler = handler;
      },
      open: (url: string) => openHandler?.({ url }),
    };
  }

  it('blocks navigation, redirects, frame navigation, webviews and new windows to anything but the app', () => {
    hoisted.created.length = 0;
    installNavigationLockdown(() => config);
    expect(hoisted.created).toHaveLength(1);
    const target = contents();
    hoisted.created[0]?.({}, target);

    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of [
        'https://evil.example/',
        'file:///C:/Windows/win.ini',
        'data:text/html,x',
        'about:blank',
        'app://evil.example/index.html',
      ]) {
        const event = { preventDefault: vi.fn() };
        target.handlers.get(name)?.(event, url);
        expect(event.preventDefault, `${name} ${url}`).toHaveBeenCalledTimes(1);
      }
    }
    // A subframe navigates on its own event, which carries the URL on the event itself.
    const frameEvent = { preventDefault: vi.fn(), url: 'https://evil.example/' };
    target.handlers.get('will-frame-navigate')?.(frameEvent);
    expect(frameEvent.preventDefault).toHaveBeenCalledTimes(1);

    const webview = { preventDefault: vi.fn() };
    target.handlers.get('will-attach-webview')?.(webview);
    expect(webview.preventDefault).toHaveBeenCalledTimes(1);

    for (const url of ['https://example.com/', 'file:///C:/x.html', 'javascript:alert(1)']) {
      expect(target.open(url)).toEqual({ action: 'deny' });
    }
  });
});

describe('session policies', () => {
  /** The role the permission handlers resolve for the requesting webContents. */
  const roleOfContents: { value: Role | undefined } = { value: undefined };

  function session() {
    const events = new Map<string, (...args: never[]) => void>();
    const calls: Record<string, unknown[]> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls[name] = args;
      };
    return {
      events,
      calls,
      setPermissionRequestHandler: record('request'),
      setPermissionCheckHandler: record('check'),
      setDevicePermissionHandler: record('device'),
      setBluetoothPairingHandler: record('bluetooth'),
      setSpellCheckerEnabled: record('spell'),
      on: (name: string, listener: (...args: never[]) => void) => events.set(name, listener),
      webRequest: { onBeforeRequest: record('beforeRequest') },
    };
  }

  it('devices that need a chooser (HID, serial, USB, Bluetooth) are never granted or offered', () => {
    const target = session();
    hoisted.created.length = 0;
    installPermissionHandlers(
      target as never,
      () => config,
      () => roleOfContents.value,
    );
    expect((target.calls.device?.[0] as () => boolean)()).toBe(false);
    for (const name of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
      const event = { preventDefault: vi.fn() };
      const callback = vi.fn();
      const listener = target.events.get(name) as (...args: unknown[]) => void;
      if (name === 'select-serial-port') listener(event, [{}], {}, callback);
      else listener(event, {}, callback);
      expect(event.preventDefault, name).toHaveBeenCalled();
      expect(callback, name).toHaveBeenCalledWith(...(name === 'select-serial-port' ? [''] : []));
    }
    const pairing = vi.fn();
    (target.calls.bluetooth?.[0] as (d: unknown, cb: (r: unknown) => void) => void)({}, pairing);
    expect(pairing).toHaveBeenCalledWith({ confirmed: false });
    const bluetooth = { preventDefault: vi.fn() };
    const chosen = vi.fn();
    hoisted.created[0]?.(
      {},
      { on: (_: string, h: (...a: unknown[]) => void) => h(bluetooth, [], chosen) },
    );
    expect(bluetooth.preventDefault).toHaveBeenCalled();
    expect(chosen).toHaveBeenCalledWith('');
    expect(target.calls.spell?.[0]).toBe(false); // no spell checker: nothing typed is sent anywhere
  });

  it('permissions: the microphone, the camera for the recorder and camera windows, clipboard writes, only for the app', () => {
    const target = session();
    installPermissionHandlers(
      target as never,
      () => config,
      () => roleOfContents.value,
    );
    const decide = target.calls.request?.[0] as (
      c: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
      details: { requestingUrl: string; mediaTypes?: string[] },
    ) => void;
    const check = target.calls.check?.[0] as (
      c: unknown,
      permission: string,
      origin: string,
      details: { requestingUrl: string; mediaType?: string },
    ) => boolean;
    const app = 'app://framecapt/index.html';
    const ask = (permission: string, requestingUrl: string, mediaTypes?: string[]) => {
      const callback = vi.fn();
      decide({}, permission, callback, { requestingUrl, ...(mediaTypes && { mediaTypes }) });
      return callback.mock.calls[0]?.[0] as boolean;
    };
    expect(ask('media', app, ['audio'])).toBe(true);
    // No registered window, or the main window: the camera is not granted.
    roleOfContents.value = undefined;
    expect(ask('media', app, ['video'])).toBe(false);
    roleOfContents.value = 'main';
    expect(ask('media', app, ['audio', 'video'])).toBe(false);
    expect(ask('media', app, ['video'])).toBe(false);
    expect(check({}, 'media', app, { requestingUrl: app, mediaType: 'video' })).toBe(true);
    for (const role of ['recorder', 'camera'] as const) {
      roleOfContents.value = role;
      expect(ask('media', app, ['video']), role).toBe(true);
      expect(ask('media', 'https://evil.example/', ['video']), role).toBe(false);
    }
    for (const role of ['editor', 'overlay', 'toolbar', 'countdown'] as const) {
      roleOfContents.value = role;
      expect(ask('media', app, ['video']), role).toBe(false);
      expect(check({}, 'media', app, { requestingUrl: app, mediaType: 'video' }), role).toBe(false);
    }
    roleOfContents.value = undefined;
    expect(ask('clipboard-sanitized-write', app)).toBe(true);
    for (const permission of [
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'bluetooth',
      'clipboard-read',
      'display-capture',
      'openExternal',
      'fullscreen',
      'pointerLock',
      'idle-detection',
    ]) {
      expect(ask(permission, app), permission).toBe(false);
    }
    expect(ask('media', 'https://evil.example/', ['audio'])).toBe(false);
  });

  it('the network blocker cancels every http(s), ws(s) and ftp request (production: all of them)', () => {
    const target = session();
    installNetworkBlocker(target as never, () => config);
    const [filter, listener] = target.calls.beforeRequest as [
      { urls: string[] },
      (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void,
    ];
    expect(filter.urls).toEqual([
      'http://*/*',
      'https://*/*',
      'ws://*/*',
      'wss://*/*',
      'ftp://*/*',
    ]);
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'wss://x.example/s']) {
      const callback = vi.fn();
      listener({ url }, callback);
      expect(callback, url).toHaveBeenCalledWith({ cancel: true });
    }
  });
});
