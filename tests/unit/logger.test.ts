import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger, redactHome } from '../../src/main/logger';

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
