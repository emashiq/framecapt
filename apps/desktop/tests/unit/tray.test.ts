import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  TrayController,
  buildTrayTemplate,
  trayTooltip,
  type TrayHandlers,
  type TrayLike,
  type TrayState,
} from '../../src/main/tray';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutStates,
} from '../../src/shared/shortcuts';

const states = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [
    action,
    { accelerator: DEFAULT_SHORTCUTS[action], status: 'ok' as const },
  ]),
) as ShortcutStates;

function handlers(): TrayHandlers {
  return {
    open: vi.fn(),
    openView: vi.fn(),
    run: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
    quit: vi.fn(),
  };
}

const idle: TrayState = {
  status: 'idle',
  activeMs: 0,
  shortcuts: states,
  screenshotBusy: false,
};

const labels = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) => (item.type === 'separator' ? '-' : (item.label ?? '?')));
const find = (items: MenuItemConstructorOptions[], id: string) =>
  items.find((item) => item.id === id);

describe('trayTooltip', () => {
  it('says FrameCapt when idle and the clock while recording', () => {
    expect(trayTooltip({ status: 'idle', activeMs: 0 })).toBe('FrameCapt');
    expect(trayTooltip({ status: 'completed', activeMs: 5000 })).toBe('FrameCapt');
    expect(trayTooltip({ status: 'recording', activeMs: 83_000 })).toBe(
      'FrameCapt — Recording 01:23',
    );
    expect(trayTooltip({ status: 'paused', activeMs: 83_999 })).toBe('FrameCapt — Paused 01:23');
    expect(trayTooltip({ status: 'stopping', activeMs: 1 })).toContain('Saving');
  });
});

describe('buildTrayTemplate', () => {
  it('idle: screenshot and record submenus, then open, history, settings, quit', () => {
    const template = buildTrayTemplate(idle, handlers());
    expect(labels(template)).toEqual([
      'Screenshot',
      'Record',
      '-',
      'Open FrameCapt',
      'History',
      'Settings',
      '-',
      'Quit FrameCapt',
    ]);
    const shot = find(template, 'screenshot')?.submenu as MenuItemConstructorOptions[];
    expect(labels(shot)).toEqual(['Screen', 'Window', 'Region']);
    expect(shot.map((item) => item.accelerator)).toEqual([
      'Ctrl+Shift+1',
      'Ctrl+Shift+2',
      'Ctrl+Shift+3',
    ]);
    // The label is shown; the global shortcut is the ShortcutManager's, not the menu's.
    expect(shot.every((item) => item.registerAccelerator === false)).toBe(true);
    const record = find(template, 'record')?.submenu as MenuItemConstructorOptions[];
    expect(record.map((item) => item.accelerator)).toEqual([
      'Ctrl+Shift+5',
      'Ctrl+Shift+6',
      'Ctrl+Shift+7',
    ]);
  });

  it('recording: pause and stop are at the top, and starting things is disabled', () => {
    const template = buildTrayTemplate({ ...idle, status: 'recording' }, handlers());
    expect(labels(template).slice(0, 3)).toEqual(['Pause recording', 'Stop recording', '-']);
    expect(find(template, 'pause')?.accelerator).toBe('Ctrl+Shift+9');
    expect(find(template, 'stop')?.accelerator).toBe('Ctrl+Shift+0');
    const record = find(template, 'record')?.submenu as MenuItemConstructorOptions[];
    expect(record.every((item) => item.enabled === false)).toBe(true);
    const shot = find(template, 'screenshot')?.submenu as MenuItemConstructorOptions[];
    expect(shot.every((item) => item.enabled === false)).toBe(true);
  });

  it('paused offers Resume; saving disables the controls', () => {
    const paused = buildTrayTemplate({ ...idle, status: 'paused' }, handlers());
    expect(find(paused, 'pause')?.label).toBe('Resume recording');
    const saving = buildTrayTemplate({ ...idle, status: 'processing' }, handlers());
    expect(find(saving, 'stop')?.enabled).toBe(false);
  });

  it('no accelerator label for a disabled shortcut', () => {
    const off: ShortcutStates = {
      ...states,
      screenshotRegion: { accelerator: null, status: 'disabled' },
    };
    const template = buildTrayTemplate({ ...idle, shortcuts: off }, handlers());
    const shot = find(template, 'screenshot')?.submenu as MenuItemConstructorOptions[];
    expect(shot[2]?.accelerator).toBeUndefined();
  });

  it('a screenshot in progress disables starting another', () => {
    const template = buildTrayTemplate({ ...idle, screenshotBusy: true }, handlers());
    const shot = find(template, 'screenshot')?.submenu as MenuItemConstructorOptions[];
    expect(shot.every((item) => item.enabled === false)).toBe(true);
  });

  it('items call the matching handler', () => {
    const h = handlers();
    const template = buildTrayTemplate(idle, h);
    const shot = find(template, 'screenshot')?.submenu as MenuItemConstructorOptions[];
    (shot[2]?.click as () => void)();
    expect(h.run).toHaveBeenCalledWith('screenshotRegion');
    (find(template, 'history')?.click as () => void)();
    expect(h.openView).toHaveBeenCalledWith('history');
    (find(template, 'quit')?.click as () => void)();
    expect(h.quit).toHaveBeenCalled();
    (find(template, 'open')?.click as () => void)();
    expect(h.open).toHaveBeenCalled();
  });
});

function fakeTray() {
  const events = new Map<string, () => void>();
  const tray: TrayLike & { image: unknown; tooltip: string; menu: unknown; destroyed: boolean } = {
    image: undefined,
    tooltip: '',
    menu: undefined,
    destroyed: false,
    setToolTip(text) {
      tray.tooltip = text;
    },
    setImage(image) {
      tray.image = image;
    },
    setContextMenu(menu) {
      tray.menu = menu;
    },
    getBounds: () => ({ x: 1, y: 2, width: 16, height: 16 }),
    on(event, listener) {
      events.set(event, listener);
    },
    destroy() {
      tray.destroyed = true;
    },
    isDestroyed: () => tray.destroyed,
  };
  return { tray, events };
}

const normal = { id: 'normal' } as unknown as NativeImage;
const recording = { id: 'recording' } as unknown as NativeImage;

describe('TrayController', () => {
  function setup() {
    const { tray, events } = fakeTray();
    const createTray = vi.fn(() => tray);
    const h = handlers();
    const controller = new TrayController({
      createTray,
      buildMenu: (template) => template,
      icons: { normal, recording },
      handlers: h,
    });
    return { controller, createTray, tray, events, h };
  }

  it('is a singleton: ensure() any number of times makes one icon', () => {
    const { controller, createTray } = setup();
    expect(controller.ensure()).toBe(true);
    expect(controller.ensure()).toBe(true);
    expect(controller.ensure()).toBe(true);
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(controller.instances).toBe(1);
    expect(controller.active).toBe(true);
    expect(controller.bounds()).toEqual({ x: 1, y: 2, width: 16, height: 16 });
  });

  it('left click and double click open the main window', () => {
    const { controller, events, h } = setup();
    controller.ensure();
    events.get('click')?.();
    events.get('double-click')?.();
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it('swaps to the red-dot icon while recording and back afterwards', () => {
    const { controller, tray } = setup();
    controller.ensure();
    controller.update({ ...idle, status: 'recording', activeMs: 1000 });
    expect(tray.image).toBe(recording);
    expect(tray.tooltip).toBe('FrameCapt — Recording 00:01');
    controller.update({ ...idle, status: 'paused', activeMs: 2000 });
    expect(tray.image).toBe(recording);
    controller.update(idle);
    expect(tray.image).toBe(normal);
    expect(tray.tooltip).toBe('FrameCapt');
  });

  it('the first state is applied when the icon is created later', () => {
    const { controller, tray } = setup();
    controller.update({ ...idle, status: 'recording', activeMs: 0 });
    controller.ensure();
    expect(tray.tooltip).toBe('FrameCapt — Recording 00:00');
  });

  it('survives a platform that cannot make a tray icon', () => {
    const controller = new TrayController({
      createTray: () => {
        throw new Error('no tray');
      },
      buildMenu: (template) => template,
      icons: { normal, recording },
      handlers: handlers(),
    });
    expect(controller.ensure()).toBe(false);
    expect(controller.active).toBe(false);
    expect(controller.bounds()).toBeNull();
    expect(() => controller.update(idle)).not.toThrow();
  });

  it('destroy removes the icon, and a later ensure makes exactly one new one', () => {
    const { controller, createTray } = setup();
    controller.ensure();
    controller.destroy();
    expect(controller.active).toBe(false);
    controller.ensure();
    expect(createTray).toHaveBeenCalledTimes(2);
    expect(controller.instances).toBe(2);
  });
});
