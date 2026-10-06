import { app, type Session } from 'electron';
import { devCsp, PROD_CSP } from '../shared/csp';
import {
  isAppUrl,
  isNetworkRequestAllowed,
  isPermissionAllowed,
  type AppOriginConfig,
} from './app-origin';
import { log } from './logger';

/**
 * Navigation lockdown. Registered once, applies to every webContents created later: a window can
 * only ever show the app's own UI, and can never open child windows or webviews.
 */
export function installNavigationLockdown(getConfig: () => AppOriginConfig): void {
  app.on('web-contents-created', (_event, contents) => {
    const guard = (event: { preventDefault: () => void }, url: string): void => {
      if (!isAppUrl(url, getConfig())) {
        event.preventDefault();
        log.warn(`Blocked navigation to ${redact(url)}`);
      }
    };
    contents.on('will-navigate', (event, url) => guard(event, url));
    // Subframes navigate on their own event (will-navigate only covers the top frame).
    contents.on('will-frame-navigate', (event) => guard(event, event.url));
    contents.on('will-redirect', (event, url) => guard(event, url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      log.warn(`Denied window.open to ${redact(url)}`);
      return { action: 'deny' };
    });
  });
}

/** Keeps only scheme + host so query strings or file names never reach the log. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(unparseable url)';
  }
}

/** CSP response header (needed for the dev server; builds also embed it as a <meta> tag). */
export function installCsp(ses: Session, config: AppOriginConfig): void {
  const policy = config.devServerUrl ? devCsp(config.devServerUrl) : PROD_CSP;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [policy];
    callback({ responseHeaders: headers });
  });
}

/**
 * Deny-by-default permissions; only `media` (the microphone) and clipboard writes, only for the
 * app's own pages.
 */
export function installPermissionHandlers(ses: Session, getConfig: () => AppOriginConfig): void {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const allowed = isPermissionAllowed(permission, details.requestingUrl, getConfig(), mediaTypes);
    if (!allowed)
      log.warn(`Denied permission request: ${permission} ${(mediaTypes ?? []).join(',')}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType ? [details.mediaType] : undefined;
    return isPermissionAllowed(
      permission,
      details.requestingUrl || requestingOrigin,
      getConfig(),
      mediaTypes,
    );
  });
  // Display capture is not a permission: see capture/display-media.ts.

  // Hardware that needs a device chooser (HID, serial, USB, Bluetooth): never granted, never asked.
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
  });
  ses.setSpellCheckerEnabled(false);
}

/**
 * No network: every http(s), ws(s) or ftp request is cancelled (the dev server of a development
 * build excepted). FrameCapt loads only its own files and `framecapt-media:`; the CSP already says so,
 * this makes it true even if a policy were ever loosened by mistake.
 */
export function installNetworkBlocker(ses: Session, getConfig: () => AppOriginConfig): void {
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (details, callback) => {
      const allowed = isNetworkRequestAllowed(details.url, getConfig());
      if (!allowed) log.warn(`Blocked network request to ${redact(details.url)}`);
      callback({ cancel: !allowed });
    },
  );
}

/**
 * No spellchecker, on every platform. Chromium's session spellchecker downloads a Hunspell
 * dictionary from Google (redirector.gvt1.com) for its language when the session starts (seen on
 * Linux in the CI network test), even though no FrameCapt window checks spelling. FrameCapt makes
 * no request of its own, so the checker is disabled and has no language to fetch a dictionary for.
 * index.ts also passes --disable-spell-checking before the app is ready.
 */
export function disableSpellChecker(
  ses: Pick<Session, 'setSpellCheckerEnabled' | 'setSpellCheckerLanguages'>,
): void {
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerLanguages([]);
}
