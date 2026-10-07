import { describe, expect, it } from 'vitest';
import { isReachable, parseEditorBounds } from '../../src/main/editor-bounds';

describe('parseEditorBounds', () => {
  const good = { x: 10, y: 20, width: 1200, height: 800, maximized: true };

  it('reads a stored rectangle', () => {
    expect(parseEditorBounds(JSON.stringify(good))).toEqual(good);
    expect(parseEditorBounds(JSON.stringify({ ...good, maximized: undefined }))?.maximized).toBe(
      false,
    );
  });

  it('refuses anything that is not a sane window', () => {
    for (const raw of [
      '',
      'not json',
      'null',
      '[]',
      JSON.stringify({ ...good, width: 100 }),
      JSON.stringify({ ...good, height: 'tall' }),
      JSON.stringify({ ...good, x: null }),
      JSON.stringify({ ...good, width: 1e9 }),
      JSON.stringify({ ...good, x: 1e9 }),
    ]) {
      expect(parseEditorBounds(raw), raw).toBeNull();
    }
  });
});

describe('isReachable', () => {
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1280, y: 0, width: 1280, height: 1024 },
  ];

  it('accepts a window on a connected display, including a negative origin', () => {
    expect(isReachable({ x: 100, y: 50, width: 1200, height: 800 }, screens)).toBe(true);
    expect(isReachable({ x: -1000, y: 20, width: 900, height: 700 }, screens)).toBe(true);
  });

  it('refuses a window left on a display that is gone', () => {
    expect(isReachable({ x: 3000, y: 100, width: 1200, height: 800 }, screens)).toBe(false);
    expect(isReachable({ x: 100, y: 2000, width: 1200, height: 800 }, screens)).toBe(false);
  });
});
