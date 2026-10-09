import { describe, expect, it, vi } from 'vitest';
import type { DisplayInfo, SourceInfo } from '../../src/main/capture/types';
import { buildScreenshotMenuTemplate } from '../../src/main/recorder/toolbar-menus';

const display = (id: string, width: number, height: number): DisplayInfo => ({
  id,
  label: `Display ${id}`,
  bounds: { x: 0, y: 0, width, height },
  scaleFactor: 1,
  rotation: 0,
  physicalSize: { width, height },
  isPrimary: id === '1',
});
const windowSource = (id: string, name: string): SourceInfo => ({ id, name, kind: 'window' });

function handlers() {
  return { recordedArea: vi.fn(), region: vi.fn(), screen: vi.fn(), window: vi.fn() };
}

describe('buildScreenshotMenuTemplate', () => {
  it('lists the recorded area, region, screens and windows', () => {
    const items = buildScreenshotMenuTemplate(
      [display('1', 1920, 1080), display('2', 2560, 1440)],
      [windowSource('window:1:0', 'Notes')],
      handlers(),
    );
    expect(items.map((item) => item.label)).toEqual([
      'Recorded area',
      'Region…',
      'Screen',
      'Window',
    ]);
    const screens = items[2]?.submenu as { label: string }[];
    expect(screens.map((item) => item.label)).toEqual([
      'Screen 1 (1920×1080)',
      'Screen 2 (2560×1440)',
    ]);
  });

  it('routes each item to its handler with the right id', () => {
    const h = handlers();
    const items = buildScreenshotMenuTemplate(
      [display('7', 800, 600)],
      [windowSource('window:5:0', 'Doc')],
      h,
    );
    (items[0]?.click as () => void)();
    (items[1]?.click as () => void)();
    ((items[2]?.submenu as { click: () => void }[])[0] as { click: () => void }).click();
    ((items[3]?.submenu as { click: () => void }[])[0] as { click: () => void }).click();
    expect(h.recordedArea).toHaveBeenCalledOnce();
    expect(h.region).toHaveBeenCalledOnce();
    expect(h.screen).toHaveBeenCalledWith('7');
    expect(h.window).toHaveBeenCalledWith('window:5:0');
  });

  it('truncates long titles to 60 characters and shows a disabled item when there are no windows', () => {
    const long = 'x'.repeat(100);
    const withLong = buildScreenshotMenuTemplate(
      [],
      [windowSource('window:1:0', long)],
      handlers(),
    );
    const label = (withLong[3]?.submenu as { label: string }[])[0]?.label ?? '';
    expect(label).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);

    const none = buildScreenshotMenuTemplate([], [], handlers());
    expect((none[3]?.submenu as { enabled?: boolean }[])[0]?.enabled).toBe(false);
  });
});
