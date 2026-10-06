import { describe, expect, it } from 'vitest';
import {
  isAppUrl,
  isNetworkRequestAllowed,
  isPermissionAllowed,
  type AppOriginConfig,
} from '../../src/main/app-origin';
import { ROLES } from '../../src/shared/types';

const prod: AppOriginConfig = {};
const dev: AppOriginConfig = { devServerUrl: 'http://localhost:5173' };

const appFile = (...segments: string[]): string => `app://framecapt/${segments.join('/')}`;

describe('isAppUrl (production, app://framecapt)', () => {
  it('accepts the app origin, with or without a role hash', () => {
    expect(isAppUrl(appFile('index.html'), prod)).toBe(true);
    expect(isAppUrl(`${appFile('index.html')}#/overlay`, prod)).toBe(true);
    expect(isAppUrl(appFile('assets', 'app.js'), prod)).toBe(true);
    expect(isAppUrl('app://FRAMECAPT/index.html', prod)).toBe(true);
  });

  it('rejects other hosts of the app scheme, lookalikes, ports and credentials', () => {
    expect(isAppUrl('app://other/index.html', prod)).toBe(false);
    expect(isAppUrl('app://framecapt.evil.example/index.html', prod)).toBe(false);
    expect(isAppUrl('app://evil.example@framecapt/index.html', prod)).toBe(false);
    expect(isAppUrl('app://framecapt:8080/index.html', prod)).toBe(false);
    expect(isAppUrl('app:///index.html', prod)).toBe(false);
    expect(isAppUrl('framecapt-media://framecapt/index.html', prod)).toBe(false);
  });

  it('rejects file://, every other scheme, and the dev server in production', () => {
    expect(isAppUrl('file:///C:/app/.vite/renderer/main_window/index.html', prod)).toBe(false);
    expect(isAppUrl('http://framecapt/', prod)).toBe(false);
    expect(isAppUrl('http://evil.example/', prod)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', prod)).toBe(false);
    expect(isAppUrl('about:blank', prod)).toBe(false);
    expect(isAppUrl('data:text/html,<h1>x</h1>', prod)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', prod)).toBe(false);
  });

  it('rejects empty and malformed input', () => {
    expect(isAppUrl(undefined, prod)).toBe(false);
    expect(isAppUrl(null, prod)).toBe(false);
    expect(isAppUrl('', prod)).toBe(false);
    expect(isAppUrl('not a url', prod)).toBe(false);
  });
});

describe('isAppUrl (development, dev server)', () => {
  it('accepts the dev server origin only', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5173/#/toolbar', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('http://localhost.evil.example:5173/', dev)).toBe(false);
    expect(isAppUrl('http://evil.example/', dev)).toBe(false);
    expect(isAppUrl('about:blank', dev)).toBe(false);
    expect(isAppUrl(appFile('index.html'), dev)).toBe(false);
    expect(isAppUrl('file:///C:/app/index.html', dev)).toBe(false);
  });
});

describe('isPermissionAllowed', () => {
  const url = appFile('index.html');

  it('allows media and clipboard writes for the app origin', () => {
    expect(isPermissionAllowed('media', url, prod)).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', url, prod)).toBe(true);
  });

  it('allows the microphone for every window', () => {
    expect(isPermissionAllowed('media', url, prod, ['audio'])).toBe(true);
    for (const role of ROLES) {
      expect(isPermissionAllowed('media', url, prod, ['audio'], role, 'request')).toBe(true);
    }
  });

  it('video requests (getUserMedia) are for the recorder and camera windows only', () => {
    for (const role of ROLES) {
      const expected = role === 'recorder' || role === 'camera';
      for (const types of [['video'], ['audio', 'video']]) {
        expect(isPermissionAllowed('media', url, prod, types, role, 'request'), role).toBe(
          expected,
        );
      }
    }
    // No role (an unregistered window), or no role given: denied.
    expect(isPermissionAllowed('media', url, prod, ['video'])).toBe(false);
    expect(isPermissionAllowed('media', url, prod, ['video'], undefined, 'request')).toBe(false);
  });

  it('video checks (device labels) are also allowed for the main window, no other', () => {
    for (const role of ROLES) {
      const expected = role === 'main' || role === 'recorder' || role === 'camera';
      expect(isPermissionAllowed('media', url, prod, ['video'], role, 'check'), role).toBe(
        expected,
      );
    }
    expect(isPermissionAllowed('media', url, prod, ['video'], undefined, 'check')).toBe(false);
  });

  it('a camera permission is still only for the app origin', () => {
    expect(
      isPermissionAllowed('media', 'http://evil.example/', prod, ['video'], 'camera', 'request'),
    ).toBe(false);
  });

  it('denies other permissions and foreign origins', () => {
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'display-capture',
      'midi',
    ]) {
      expect(isPermissionAllowed(permission, url, prod)).toBe(false);
    }
    expect(isPermissionAllowed('media', 'http://evil.example/', prod)).toBe(false);
    expect(isPermissionAllowed('media', undefined, prod)).toBe(false);
  });
});

describe('isNetworkRequestAllowed', () => {
  it('production builds make no network request at all', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/',
      'ws://localhost:5173/',
      'wss://example.com/socket',
      'ftp://example.com/x',
      'not a url',
    ]) {
      expect(isNetworkRequestAllowed(url, prod), url).toBe(false);
    }
  });

  it('a development build may talk to its own dev server (and its websocket) and to nothing else', () => {
    expect(isNetworkRequestAllowed('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isNetworkRequestAllowed('ws://localhost:5173/', dev)).toBe(true);
    expect(isNetworkRequestAllowed('https://localhost:5173/', dev)).toBe(false);
    expect(isNetworkRequestAllowed('http://localhost:5174/', dev)).toBe(false);
    expect(isNetworkRequestAllowed('http://localhost.evil.example:5173/', dev)).toBe(false);
    expect(isNetworkRequestAllowed('http://evil.example/', dev)).toBe(false);
    expect(isNetworkRequestAllowed('ftp://localhost:5173/', dev)).toBe(false);
  });
});
