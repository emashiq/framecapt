import type { WinInfo, WindowProbe } from './window-probe';

/**
 * E2E builds only (compiled in through a dynamic import behind __FRAMECAPT_E2E__, see
 * create-probe.ts; scripts/check-no-mocks.mjs proves it is absent from normal builds): an
 * in-memory window list and microphone list the tests drive through `globalThis.__frameCaptProbe`.
 */
export class MockWindowProbe implements WindowProbe {
  readonly kind = 'mock' as const;
  private windows: WinInfo[] = [];
  private mic: string[] = [];
  private foregroundHwnd: string | null = null;

  list(): Promise<WinInfo[]> {
    return Promise.resolve(this.windows.map((window) => ({ ...window })));
  }

  get(hwnd: string): Promise<WinInfo | null> {
    const found = this.windows.find((window) => window.hwnd === hwnd);
    return Promise.resolve(found ? { ...found } : null);
  }

  micInUse(): Promise<string[]> {
    return Promise.resolve([...this.mic]);
  }

  foreground(): Promise<string | null> {
    return Promise.resolve(this.foregroundHwnd);
  }

  dispose(): void {
    // Nothing is held.
  }

  setWindows(windows: WinInfo[]): void {
    this.windows = windows.map((window) => ({ ...window }));
  }

  setMicInUse(apps: string[]): void {
    this.mic = [...apps];
  }

  setForeground(hwnd: string | null): void {
    this.foregroundHwnd = hwnd;
  }

  /** Publishes the three test operations for Playwright's `electronApp.evaluate`. */
  exposeTestHook(): void {
    (globalThis as Record<string, unknown>).__frameCaptProbe = {
      setWindows: (windows: WinInfo[]) => this.setWindows(windows),
      setMicInUse: (apps: string[]) => this.setMicInUse(apps),
      setForeground: (hwnd: string | null) => this.setForeground(hwnd),
    };
  }
}
