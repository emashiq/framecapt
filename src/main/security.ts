import { app, type Session } from 'electron';
import { devCsp, PROD_CSP } from '../shared/csp';
import { isAppUrl, isPermissionAllowed, type AppOriginConfig } from './app-origin';
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

/** Deny-by-default permissions; only `media` and clipboard writes, only for the app's own pages. */
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
  // Display capture is not a permission: see capture/authorization.ts.
}
