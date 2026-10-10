import { describe, expect, it } from 'vitest';
import type { WindowProbe } from '../../src/main/platform/window-probe';

async function loadProbe(): Promise<WindowProbe | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { Win32WindowProbe } = await import('../../src/main/platform/win32-probe');
    return new Win32WindowProbe();
  } catch {
    return null; // koffi could not load: the fallback probe is used instead.
  }
}

const loaded = await loadProbe();

describe.skipIf(loaded === null)('Win32WindowProbe (smoke, real Windows)', () => {
  const probe = loaded as WindowProbe;

  it('lists windows with the documented shape', async () => {
    const windows = await probe.list();
    expect(Array.isArray(windows)).toBe(true);
    for (const window of windows) {
      expect(window.hwnd).toMatch(/^\d+$/);
      expect(typeof window.title).toBe('string');
      expect(typeof window.className).toBe('string');
      expect(Number.isInteger(window.pid)).toBe(true);
      expect(window.exe).toBe(window.exe.toLowerCase());
      expect(typeof window.minimized).toBe('boolean');
      expect(typeof window.cloaked).toBe('boolean');
      expect(window.rect.width).toBeGreaterThanOrEqual(0);
      expect(window.pid).not.toBe(process.pid);
    }
  });

  it('returns the foreground window or null, and describes a listed window', async () => {
    const foreground = await probe.foreground();
    expect(foreground === null || /^\d+$/.test(foreground)).toBe(true);
    const [first] = await probe.list();
    if (first) expect((await probe.get(first.hwnd))?.hwnd).toBe(first.hwnd);
    expect(await probe.get('1')).toBeNull();
  });

  it('reads the microphone consent store', async () => {
    const apps = await probe.micInUse();
    expect(Array.isArray(apps)).toBe(true);
    for (const app of apps) expect(app).toBe(app.toLowerCase());
  });
});
