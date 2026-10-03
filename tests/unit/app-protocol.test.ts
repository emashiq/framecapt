import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (request: { url: string }) => Promise<Response>>(),
  privileged: [] as unknown[],
}));

vi.mock('electron', () => ({
  protocol: {
    handle: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => {
      hoisted.handlers.set(scheme, handler);
    },
    registerSchemesAsPrivileged: (schemes: unknown[]) => hoisted.privileged.push(...schemes),
  },
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import { registerAppProtocol, registerPrivilegedSchemes } from '../../src/main/app-protocol';

describe('the app:// protocol handler', () => {
  let work: string;
  let renderer: string;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-app-protocol-'));
    renderer = path.join(work, 'renderer');
    fs.mkdirSync(path.join(renderer, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(renderer, 'index.html'), '<!doctype html><title>x</title>');
    fs.writeFileSync(path.join(renderer, 'assets', 'app.js'), 'console.log(1)');
    // Files next to (outside) the renderer directory that must never be reachable.
    fs.writeFileSync(path.join(work, 'secret.js'), 'secret');
    fs.writeFileSync(path.join(renderer, 'notes.txt'), 'not a served type');
    registerAppProtocol(renderer);
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  const get = (url: string) => {
    const handler = hoisted.handlers.get('app');
    if (!handler) throw new Error('no handler registered');
    return handler({ url });
  };

  it('registers both privileged schemes in one call, without the risky privileges', () => {
    registerPrivilegedSchemes();
    const app = (
      hoisted.privileged as { scheme: string; privileges: Record<string, boolean> }[]
    ).find((entry) => entry.scheme === 'app');
    expect(app?.privileges).toEqual({ standard: true, secure: true });
    expect((hoisted.privileged as { scheme: string }[]).map((entry) => entry.scheme)).toContain(
      'framecapt-media',
    );
  });

  it('serves the entry document and assets with MIME type, CSP and nosniff', async () => {
    const entry = await get('app://framecapt/index.html#/overlay');
    expect(entry.status).toBe(200);
    expect(entry.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(entry.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(entry.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await entry.text()).toContain('<title>x</title>');

    const script = await get('app://framecapt/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('console.log(1)');

    expect((await get('app://framecapt/')).status).toBe(200);
  });

  it('answers 404/400 for anything else and never returns a file outside the directory', async () => {
    const cases: [string, number][] = [
      ['app://framecapt/notes.txt', 404], // exists, but not a served type
      ['app://framecapt/missing.js', 404], // served type, not there
      ['app://framecapt/../secret.js', 400], // traversal
      ['app://framecapt/%2e%2e/secret.js', 400],
      ['app://framecapt/assets/..%2f..%2fsecret.js', 400],
      ['app://framecapt/assets/', 400], // a directory
      ['app://other/index.html', 404],
    ];
    for (const [url, status] of cases) {
      const response = await get(url);
      expect(response.status, url).toBe(status);
      expect(await response.text(), url).not.toContain('secret');
    }
  });
});
