import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/main/logger';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-log-'));
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

  it('caps very long messages', () => {
    const dir = tempDir();
    new Logger(dir).info('y'.repeat(100_000));
    expect(fs.statSync(path.join(dir, 'main.log')).size).toBeLessThan(9000);
  });
});
