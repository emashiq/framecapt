import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { fuzzyMatch, highlightRuns } from '../../src/renderer/commands/fuzzy';
import {
  COLLAPSE_MENUS_BELOW,
  ICON_SEARCH_BELOW,
  titleBarLayout,
} from '../../src/renderer/commands/layout';
import { MAX_RECENTS, loadRecents, pushRecent } from '../../src/renderer/commands/recents';
import {
  MENUS,
  buildCommands,
  hintFor,
  rankCommands,
  type CommandActions,
  type CommandEnv,
} from '../../src/renderer/commands/registry';
import { titleBarOverlay, titleBarWindowOptions } from '../../src/main/title-bar';

const env = (overrides: Partial<CommandEnv> = {}): CommandEnv => ({
  recorderStatus: 'idle',
  ...overrides,
});

function actions(): CommandActions {
  return {
    startCapture: vi.fn(),
    stopRecording: vi.fn(),
    togglePause: vi.fn(),
    navigate: vi.fn(),
    showKeyboardHelp: vi.fn(),
    openImage: vi.fn(),
    toggleTheme: vi.fn(),
    quit: vi.fn(),
    openCommandCenter: vi.fn(),
  };
}

const find = (commands: ReturnType<typeof buildCommands>, id: string) => {
  const command = commands.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command;
};

const idsOf = (groups: ReturnType<typeof rankCommands>): string[] =>
  groups.flatMap((group) => group.items.map(({ command }) => command.id));

describe('fuzzyMatch', () => {
  it('matches everything on an empty query and nothing that lacks a letter', () => {
    expect(fuzzyMatch('', 'Open History')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('xyz', 'Open History')).toBeNull();
  });

  it('ranks a prefix above a word start above the middle of a word above a subsequence', () => {
    const prefix = fuzzyMatch('rec', 'Record – region')?.score ?? 0;
    const wordStart = fuzzyMatch('rec', 'Stop recording')?.score ?? 0;
    const inside = fuzzyMatch('cor', 'Record – region')?.score ?? 0;
    const subsequence = fuzzyMatch('rcd', 'Record – region')?.score ?? 0;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(subsequence);
  });

  it('needs every word of the query and reports the characters to highlight', () => {
    expect(fuzzyMatch('take reg', 'Take screenshot – region')).not.toBeNull();
    expect(fuzzyMatch('take zzz', 'Take screenshot – region')).toBeNull();
    const match = fuzzyMatch('hist', 'Open History');
    expect(match?.indices).toEqual([5, 6, 7, 8]);
    expect(highlightRuns('Open History', match?.indices ?? [])).toEqual([
      { text: 'Open ', hit: false },
      { text: 'Hist', hit: true },
      { text: 'ory', hit: false },
    ]);
  });
});

describe('rankCommands', () => {
  const commands = buildCommands(env(), actions());

  it('lists the screenshot commands first for "screen"', () => {
    const groups = rankCommands(commands, 'screen');
    expect(groups[0]?.heading).toBe('Capture');
    const titles = groups[0]?.items.map(({ command }) => command.title) ?? [];
    expect(titles.slice(0, 3).every((title) => title.startsWith('Take screenshot'))).toBe(true);
    expect(titles).toContain('Record – screen');
  });

  it('puts the best title match first inside a group', () => {
    const [group] = rankCommands(commands, 'history');
    expect(group?.heading).toBe('Navigate');
    expect(group?.items[0]?.command.id).toBe('nav.history');
  });

  it('finds a command by a keyword that is not in its title', () => {
    expect(idsOf(rankCommands(commands, 'dark mode'))).toContain('view.toggleTheme');
    expect(idsOf(rankCommands(commands, 'editable data'))).toContain('settings.screenshots');
  });

  it('shows no groups for a query nothing matches', () => {
    expect(rankCommands(commands, 'qqqqzzzz')).toEqual([]);
  });

  it('lists the recent commands first when the query is empty, without repeating them', () => {
    const groups = rankCommands(commands, '', ['nav.settings', 'shot.region', 'gone.id']);
    expect(groups[0]?.heading).toBe('Recent');
    expect(groups[0]?.items.map(({ command }) => command.id)).toEqual([
      'nav.settings',
      'shot.region',
    ]);
    const rest = idsOf(groups.slice(1));
    expect(rest).not.toContain('nav.settings');
    expect(rest).toContain('shot.window');
  });

  it('keeps menu-only commands out of the palette', () => {
    expect(idsOf(rankCommands(commands, ''))).not.toContain('view.commandCenter');
  });
});

describe('disabled reasons (explanation only)', () => {
  it('is available with an idle recorder', () => {
    const commands = buildCommands(env(), actions());
    expect(find(commands, 'shot.region').disabledReason).toBeNull();
    expect(find(commands, 'rec.screen').disabledReason).toBeNull();
  });

  it('disables captures while a recording runs, and offers stop and pause instead', () => {
    const commands = buildCommands(env({ recorderStatus: 'recording' }), actions());
    expect(find(commands, 'shot.region').disabledReason).toMatch(/recording is in progress/);
    expect(find(commands, 'rec.stop').disabledReason).toBeNull();
    expect(find(commands, 'rec.pause').title).toBe('Pause recording');
    const paused = buildCommands(env({ recorderStatus: 'paused' }), actions());
    expect(find(paused, 'rec.pause').title).toBe('Resume recording');
  });

  it('has no stop or pause when nothing records', () => {
    const ids = buildCommands(env(), actions()).map((command) => command.id);
    expect(ids).not.toContain('rec.stop');
    expect(ids).not.toContain('rec.pause');
  });
});

describe('commands call the app actions', () => {
  it('runs the same actions the buttons use', () => {
    const calls = actions();
    const commands = buildCommands(env(), calls);
    find(commands, 'shot.window').run();
    find(commands, 'rec.region').run();
    find(commands, 'settings.shortcuts').run();
    find(commands, 'help.shortcuts').run();
    expect(calls.startCapture).toHaveBeenNthCalledWith(1, 'screenshot', 'window');
    expect(calls.startCapture).toHaveBeenNthCalledWith(2, 'record', 'region');
    expect(calls.navigate).toHaveBeenCalledWith('settings', 'shortcuts');
    expect(calls.showKeyboardHelp).toHaveBeenCalled();
  });

  it('Open image is in the palette and at the top of the File menu, and runs the app action', () => {
    const calls = actions();
    const commands = buildCommands(env(), calls);
    expect(idsOf(rankCommands(commands, 'open image'))).toContain('file.openImage');
    expect(MENUS.find((menu) => menu.id === 'file')?.items[0]).toBe('file.openImage');
    expect(hintFor(find(commands, 'file.openImage'), DEFAULT_SETTINGS)).toEqual(['Ctrl', 'O']);
    find(commands, 'file.openImage').run();
    expect(calls.openImage).toHaveBeenCalledTimes(1);
  });

  it('every menu entry is a known command', () => {
    const ids = new Set(buildCommands(env(), actions()).map((command) => command.id));
    for (const menu of MENUS) {
      for (const id of menu.items) if (id !== null) expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('shortcut hints', () => {
  const commands = buildCommands(env(), actions());

  it('reads the live setting', () => {
    expect(hintFor(find(commands, 'shot.region'), DEFAULT_SETTINGS)).toEqual([
      'Ctrl',
      'Shift',
      '3',
    ]);
    const changed = {
      ...DEFAULT_SETTINGS,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, screenshotRegion: 'Alt+F9' },
    };
    expect(hintFor(find(commands, 'shot.region'), changed)).toEqual(['Alt', 'F9']);
  });

  it('says Not set for an unset shortcut and nothing for a command without one', () => {
    const unset = {
      ...DEFAULT_SETTINGS,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, recordRegion: null },
    };
    expect(hintFor(find(commands, 'rec.region'), unset)).toBe('Not set');
    expect(hintFor(find(commands, 'nav.history'), DEFAULT_SETTINGS)).toBeNull();
  });

  it('shows the command center key from the editable in-app shortcuts', () => {
    expect(hintFor(find(commands, 'view.commandCenter'), DEFAULT_SETTINGS)).toEqual(['Ctrl', 'K']);
    expect(hintFor(find(commands, 'help.shortcuts'), DEFAULT_SETTINGS)).toEqual(['?']);
  });
});

describe('recent commands', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  it('keeps the newest five, newest first, without duplicates', () => {
    const store = memory();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) pushRecent(id, store);
    expect(loadRecents(store)).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(loadRecents(store)).toHaveLength(MAX_RECENTS);
  });

  it('survives storage that throws, is missing or holds garbage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadRecents(broken)).toEqual([]);
    expect(pushRecent('a', broken)).toEqual(['a']);
    expect(loadRecents(null)).toEqual([]);
    expect(pushRecent('a', null)).toEqual(['a']);
    const garbage = { getItem: () => '{"not":"a list"}', setItem: () => undefined };
    expect(loadRecents(garbage)).toEqual([]);
    const mixed = { getItem: () => '["a", 3, null, "b"]', setItem: () => undefined };
    expect(loadRecents(mixed)).toEqual(['a', 'b']);
  });
});

describe('title bar layout and window options', () => {
  it('collapses the menus and then the search box as the room shrinks', () => {
    const full = { collapsedMenus: false, iconSearch: false };
    expect(titleBarLayout(900)).toEqual(full);
    expect(titleBarLayout(COLLAPSE_MENUS_BELOW)).toEqual(full);
    expect(titleBarLayout(COLLAPSE_MENUS_BELOW - 1)).toEqual({
      collapsedMenus: true,
      iconSearch: false,
    });
    expect(titleBarLayout(ICON_SEARCH_BELOW - 1)).toEqual({
      collapsedMenus: true,
      iconSearch: true,
    });
  });

  it('the window minimum (860) without the window buttons still shows the full bar', () => {
    expect(titleBarLayout(860 - 138).collapsedMenus).toBe(false);
  });

  it('uses the window-controls overlay on Windows and Linux only, with theme colours', () => {
    for (const platform of ['win32', 'linux']) {
      expect(titleBarWindowOptions(platform, false)).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#f1f5f9', symbolColor: '#0f172a', height: 36 },
      });
    }
    expect(titleBarWindowOptions('darwin', true)).toEqual({});
    expect(titleBarOverlay(true)).toEqual({ color: '#0f1424', symbolColor: '#e8ebf4', height: 36 });
  });
});
