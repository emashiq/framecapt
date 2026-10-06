import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger, redactHome, redactSecrets } from '../../src/main/logger';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Logger', () => {
  it('appends lines to main.log', () => {
    const dir = path.join(tempDir(), 'logs');
    const logger = new Logger(dir);
    logger.info('hello');
    logger.error('failed', new Error('boom'));
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(text).toMatch(/\[info\] hello/);
    expect(text).toMatch(/\[error\] failed Error: boom/);
  });

  it('rotates to a single old file when the size limit is exceeded', () => {
    const dir = tempDir();
    const logger = new Logger(dir, 500);
    for (let i = 0; i < 40; i += 1) logger.info(`line ${i} ${'x'.repeat(40)}`);
    expect(fs.existsSync(path.join(dir, 'main.old.log'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'main.log')).size).toBeLessThanOrEqual(500);
    expect(fs.readdirSync(dir).sort()).toEqual(['main.log', 'main.old.log']);
    expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).toMatch(/line 39/);
  });

  it('replaces the home folder in every slash style and case, and leaves other text alone', () => {
    const home = 'C:\\Users\\Jane Doe';
    const text = [
      'open C:\\Users\\Jane Doe\\Videos\\FrameCapt\\a.webm failed',
      'open C:/Users/Jane Doe/Videos/a.webm failed',
      'json "C:\\\\Users\\\\Jane Doe\\\\x"',
      'c:\\users\\jane doe\\x',
      'D:\\Capture\\clip.webm stays',
    ].join('\n');
    const out = redactHome(text, home);
    expect(out).not.toMatch(/Jane/i);
    expect(out).toContain('~\\Videos\\FrameCapt\\a.webm');
    expect(out).toContain('~/Videos/a.webm');
    expect(out).toContain('D:\\Capture\\clip.webm stays');
    expect(redactHome('nothing here', home)).toBe('nothing here');
    expect(redactHome('x', '')).toBe('x');
  });

  it('writes the real home folder as ~ (a log attached to a bug report has no user name)', () => {
    const dir = tempDir();
    const logger = new Logger(dir);
    logger.info(`save failed: ${path.join(os.homedir(), 'Videos', 'a.webm')}`);
    logger.error('crash', new Error(`cannot read ${os.homedir()}`));
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(text.toLowerCase()).not.toContain(os.homedir().toLowerCase());
    expect(text).toContain('~');
  });

  it('caps very long messages', () => {
    const dir = tempDir();
    new Logger(dir).info('y'.repeat(100_000));
    expect(fs.statSync(path.join(dir, 'main.log')).size).toBeLessThan(9000);
  });
});

describe('redactSecrets', () => {
  const jwt =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1LTEiLCJkZXYiOiJkLTEifQ.c2lnbmF0dXJlLWJ5dGVz';

  it('removes JWTs, bearer values, token fields and callback code/state', () => {
    const input = [
      'GET /x Authorization: Bearer abcdefghijklmnop123456',
      'token response {"access_token":"at-12345","refresh_token":"rt-67890","id_token":"' +
        jwt +
        '","expires_in":900}',
      'form: grant_type=refresh_token&refresh_token=rt-67890&client_id=framecapt-desktop',
      'callback http://127.0.0.1:50000/desktop-callback?code=code-77&state=stateval&iss=https%3A%2F%2Fx',
      'verifier code_verifier=abcDEF123_-xyz and bare jwt ' + jwt,
      'access_token: at-99999 nonce=n0nce',
    ].join('\n');
    const out = redactSecrets(input);
    for (const secret of [
      'abcdefghijklmnop123456',
      'at-12345',
      'rt-67890',
      jwt,
      'code-77',
      'stateval',
      'abcDEF123_-xyz',
      'at-99999',
      'n0nce',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('[redacted');
    // What is useful for diagnosis stays.
    expect(out).toContain('grant_type=refresh_token');
    expect(out).toContain('client_id=framecapt-desktop');
    expect(out).toContain('expires_in":900');
  });

  it('leaves ordinary diagnostics alone', () => {
    const text = 'Settings file could not be read (code: ENOENT) at C:/x state ok';
    expect(redactSecrets(text)).toBe(text);
  });

  it('the logger applies it to messages and errors', () => {
    const dir = tempDir();
    const logger = new Logger(dir);
    logger.info('refresh_token=rt-abc123 sent');
    logger.error('failed', new Error('Bearer zzzzzzzzzzzzzzzz leaked ' + jwt));
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(text).not.toMatch(/rt-abc123|zzzzzzzzzzzzzzzz|eyJhbGci/);
    expect(text).toContain('[redacted');
  });
});
