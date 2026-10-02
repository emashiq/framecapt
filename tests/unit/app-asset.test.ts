import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, APP_ORIGIN, resolveAppAsset } from '../../src/main/app-asset';

const root = path.resolve('app', 'resources', 'app.asar', '.vite', 'renderer', 'main_window');
const resolve = (url: string) => resolveAppAsset(url, root);

describe('resolveAppAsset: what the app:// protocol serves', () => {
  it('serves the entry document for / and /index.html, with the hash ignored', () => {
    const entry = path.join(root, 'index.html');
    for (const url of [
      `${APP_ORIGIN}/`,
      APP_ENTRY_URL,
      `${APP_ENTRY_URL}#/overlay`,
      `${APP_ENTRY_URL}?x=1#/toolbar`,
    ]) {
      expect(resolve(url), url).toEqual({
        ok: true,
        file: entry,
        contentType: 'text/html; charset=utf-8',
      });
    }
  });

  it('serves built assets with the right MIME type', () => {
    const cases: [string, string][] = [
      ['assets/index-B9rWDC1e.js', 'text/javascript; charset=utf-8'],
      ['assets/index-jCrJT-jn.css', 'text/css; charset=utf-8'],
      ['assets/inter-latin-wght-normal-Dx4kXJAl.woff2', 'font/woff2'],
      ['logo.svg', 'image/svg+xml'],
      ['favicon.ico', 'image/x-icon'],
      ['pic.PNG', 'image/png'],
    ];
    for (const [rel, contentType] of cases) {
      expect(resolve(`${APP_ORIGIN}/${rel}`), rel).toEqual({
        ok: true,
        file: path.join(root, ...rel.split('/')),
        contentType,
      });
    }
  });

  it('percent-encoded characters that are harmless are decoded', () => {
    const result = resolve(`${APP_ORIGIN}/assets/a%20b.js`);
    expect(result).toEqual({
      ok: true,
      file: path.join(root, 'assets', 'a b.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
  });
});

describe('resolveAppAsset: traversal and escapes are refused', () => {
  const refused: [string, string][] = [
    [
      'dot-dot (the URL parser folds it, the result must still stay inside)',
      '/assets/../../secrets.js',
    ],
    ['dot-dot at the start', '/../secrets.js'],
    ['encoded dot-dot (%2e%2e)', '/%2e%2e/%2e%2e/secrets.js'],
    ['mixed-case encoded dot-dot', '/assets/%2E%2e/secrets.js'],
    ['encoded slash then dot-dot', '/assets/..%2f..%2fsecrets.js'],
    ['encoded backslash', '/assets/..%5c..%5csecrets.js'],
    ['double-encoded dot-dot', '/%252e%252e/secrets.js'],
    ['double-encoded slash', '/assets/%252e%252e%252fsecrets.js'],
    ['literal backslash', '/assets\\..\\secrets.js'],
    ['drive letter', '/C:/Windows/system.ini.js'],
    ['encoded drive colon', '/C%3A/secrets.js'],
    ['NUL byte', '/index.html%00.js'],
    ['empty segment (//)', '//etc/passwd.js'],
    ['malformed percent escape', '/assets/%E0%A4%A.js'],
  ];
  for (const [name, pathname] of refused) {
    it(name, () => {
      const result = resolve(`${APP_ORIGIN}${pathname}`);
      expect(result.ok, pathname).toBe(false);
    });
  }

  it('never resolves outside the renderer directory, whatever the input', () => {
    const attempts = [
      '/..%2f..%2f..%2fWindows%2fwin.ini',
      '/assets/..%2f..%2f..%2f..%2fx.js',
      '/%2e%2e%2f%2e%2e%2fx.js',
      '/....//x.js',
      '/assets/....%2f%2fx.js',
    ];
    for (const attempt of attempts) {
      const result = resolve(`${APP_ORIGIN}${attempt}`);
      if (result.ok) {
        const relative = path.relative(root, result.file);
        expect(relative.startsWith('..') || path.isAbsolute(relative), attempt).toBe(false);
      }
    }
  });
});

describe('resolveAppAsset: unknown files, hosts and schemes', () => {
  it('refuses unknown extensions and extensionless names (404, filesystem untouched)', () => {
    for (const rel of [
      'secrets.txt',
      'main.cjs',
      'app.exe',
      'data.bin',
      'README',
      'a.js.map',
      'x.asar',
    ]) {
      expect(resolve(`${APP_ORIGIN}/${rel}`), rel).toEqual({ ok: false, status: 404 });
    }
  });

  it('refuses a directory-style path', () => {
    expect(resolve(`${APP_ORIGIN}/assets/`).ok).toBe(false);
  });

  it('refuses other hosts, ports, credentials and schemes', () => {
    for (const url of [
      'app://other/index.html',
      'app://framelet.evil.example/index.html',
      'app://framelet:81/index.html',
      'app://user@framelet/index.html',
      'app:///index.html',
      'file:///C:/app/index.html',
      'https://framelet/index.html',
      'framelet-media://framelet/index.html',
    ]) {
      expect(resolve(url).ok, url).toBe(false);
    }
  });

  it('refuses something that is not a URL', () => {
    expect(resolve('not a url')).toEqual({ ok: false, status: 400 });
    expect(resolve('')).toEqual({ ok: false, status: 400 });
  });
});
