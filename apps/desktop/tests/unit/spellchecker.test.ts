/**
 * The "no network" promise includes the spellchecker: Chromium's session spellchecker fetches a
 * dictionary from Google unless it is off and has no language (found by the Linux CI network test).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: () => undefined } }));

import { disableSpellChecker } from '../../src/main/security';

describe('disableSpellChecker', () => {
  it('turns the checker off and gives it no language, so no dictionary is ever fetched', () => {
    const calls: [string, unknown][] = [];
    disableSpellChecker({
      setSpellCheckerEnabled: (enabled: boolean) => calls.push(['enabled', enabled]),
      setSpellCheckerLanguages: (languages: string[]) => calls.push(['languages', languages]),
    });
    expect(calls).toEqual([
      ['enabled', false],
      ['languages', []],
    ]);
  });

  it('is applied by the main process at startup, for every platform (no platform check)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain('disableSpellChecker(session.defaultSession)');
    expect(source).toContain("app.commandLine.appendSwitch('disable-spell-checking')");
  });
});
