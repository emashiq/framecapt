import { describe, expect, it } from 'vitest';
import {
  parsePrefs,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from '../../src/shared/library-prefs';

describe('the Library view options', () => {
  it('start with sensible defaults when nothing (or nothing usable) is stored', () => {
    const defaults = {
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT,
      view: 'grid',
      sort: 'newest',
      includeSubfolders: true,
    };
    expect(parsePrefs(null)).toEqual(defaults);
    expect(parsePrefs('not json')).toEqual(defaults);
    expect(parsePrefs('42')).toEqual(defaults);
  });

  it('keeps what is valid and clamps the sidebar width to 200..360', () => {
    expect(
      parsePrefs(
        JSON.stringify({
          sidebarCollapsed: true,
          sidebarWidth: 280.4,
          view: 'list',
          sort: 'size',
          includeSubfolders: false,
        }),
      ),
    ).toEqual({
      sidebarCollapsed: true,
      sidebarWidth: 280,
      view: 'list',
      sort: 'size',
      includeSubfolders: false,
    });
    expect(parsePrefs(JSON.stringify({ sidebarWidth: 10 })).sidebarWidth).toBe(SIDEBAR_MIN);
    expect(parsePrefs(JSON.stringify({ sidebarWidth: 9999 })).sidebarWidth).toBe(SIDEBAR_MAX);
  });

  it('ignores a value of the wrong kind', () => {
    const prefs = parsePrefs(
      JSON.stringify({ sidebarWidth: 'wide', view: 'tiles', sort: 'random', sidebarCollapsed: 1 }),
    );
    expect(prefs.sidebarWidth).toBe(SIDEBAR_DEFAULT);
    expect(prefs.view).toBe('grid');
    expect(prefs.sort).toBe('newest');
    expect(prefs.sidebarCollapsed).toBe(false);
  });
});
