import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isAppUrl,
  isNetworkRequestAllowed,
  isPermissionAllowed,
  type AppOriginConfig,
} from '../../src/main/app-origin';

const rendererDir = path.resolve('some', 'app', '.vite', 'renderer', 'main_window');
const prod: AppOriginConfig = { rendererDir };
const dev: AppOriginConfig = { rendererDir, devServerUrl: 'http://localhost:5173' };

const appFile = (...segments: string[]): string =>
  pathToFileURL(path.join(rendererDir, ...segments)).href;

describe('isAppUrl (production, file://)', () => {
  it('accepts the renderer entry, with or without a role hash', () => {
    expect(isAppUrl(appFile('index.html'), prod)).toBe(true);
    expect(isAppUrl(`${appFile('index.html')}#/overlay`, prod)).toBe(true);
    expect(isAppUrl(appFile('assets', 'app.js'), prod)).toBe(true);
  });

  it('rejects other file paths, including traversal and prefix lookalikes', () => {
    expect(isAppUrl(pathToFileURL(path.resolve('other', 'index.html')).href, prod)).toBe(false);
    expect(isAppUrl(pathToFileURL(path.resolve('some', 'app', 'secrets.txt')).href, prod)).toBe(
      false,
    );
    expect(isAppUrl(`${appFile('index.html')}/../../../../x.html`, prod)).toBe(false);
    expect(isAppUrl(pathToFileURL(`${rendererDir}-evil${path.sep}index.html`).href, prod)).toBe(
      false,
    );
  });

  it('rejects the renderer directory itself and non-file schemes', () => {
    expect(isAppUrl(pathToFileURL(rendererDir).href, prod)).toBe(false);
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
  });
});

describe('isPermissionAllowed', () => {
  const url = appFile('index.html');

  it('allows media and clipboard writes for the app origin', () => {
    expect(isPermissionAllowed('media', url, prod)).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', url, prod)).toBe(true);
  });

  it('allows the microphone but denies any media request that includes video', () => {
    expect(isPermissionAllowed('media', url, prod, ['audio'])).toBe(true);
    expect(isPermissionAllowed('media', url, prod, ['video'])).toBe(false);
    expect(isPermissionAllowed('media', url, prod, ['audio', 'video'])).toBe(false);
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
