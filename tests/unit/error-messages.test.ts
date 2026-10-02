import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_ERROR_CODES,
  friendlyError,
  isKnownErrorCode,
} from '../../src/shared/error-messages';
import { IPC_ERROR_CODES } from '../../src/shared/types';

const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });
}

/**
 * Every code the app throws or returns, found by scanning the sources for the places that mint
 * them. A code added without copy fails here, so no failure ever shows a raw code to a user.
 */
function codesInSources(): Map<string, string> {
  const patterns = [
    /new (?:IpcError|FlowFailure|StartFailure|FfmpegError|WorkerError)\(\s*'([A-Za-z_-]+)'/g,
    /\bfailure\(\s*'([A-Z_]+)'/g,
    /\bfail\(\s*'([A-Z_]+)'/g,
    /\bcode:\s*'([A-Z][A-Z_]+)'/g,
    /reportError\(\s*'([A-Z_]+)'/g,
    /failActive\(\s*'([A-Z_]+)'/g,
    /new CaptureError\(\s*'([a-z-]+)'/g,
  ];
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const code = match[1];
        if (code) found.set(code, path.relative(SRC, file));
      }
    }
  }
  return found;
}

describe('error messages', () => {
  it('has copy for every IPC error code', () => {
    for (const code of IPC_ERROR_CODES) {
      expect(isKnownErrorCode(code), code).toBe(true);
      expect(friendlyError(code).length, code).toBeGreaterThan(10);
    }
  });

  it('has copy for every code the sources can produce', () => {
    const found = codesInSources();
    expect(found.size).toBeGreaterThan(30); // the scan itself works
    const missing = [...found]
      .filter(([code]) => !isKnownErrorCode(code))
      .map(([code, file]) => `${code} (${file})`);
    expect(missing).toEqual([]);
  });

  it('the copy tells people what to do: no raw codes, no stack text, a next step', () => {
    for (const code of KNOWN_ERROR_CODES) {
      const text = friendlyError(code);
      expect(text, code).not.toMatch(/[A-Z]{4,}_[A-Z]{3,}/);
      expect(text, code).not.toMatch(/\bat \w+\.\w+ \(/);
      expect(text.endsWith('.') || text.endsWith('…'), code).toBe(true);
    }
  });

  it('DISK_LOW names the fix', () => {
    expect(friendlyError('DISK_LOW')).toBe(
      'Your disk is almost full. Free up space or choose another folder in Settings → Recording.',
    );
  });

  it('lets a specific server message lead where it is better than the generic one', () => {
    expect(friendlyError('NOT_FOUND', 'That window is no longer available.')).toBe(
      'That window is no longer available. Refresh and try again.',
    );
    expect(friendlyError('NOT_FOUND')).toContain('no longer available');
    expect(friendlyError('BUSY', 'Some detail')).toContain('already running');
  });

  it('unknown codes fall back to the message, or a generic line', () => {
    expect(friendlyError('SOMETHING_NEW', 'Specific words.')).toBe('Specific words.');
    expect(friendlyError(undefined, undefined)).toContain('Something went wrong');
    expect(friendlyError('SOMETHING_NEW')).toContain('Something went wrong');
  });
});
