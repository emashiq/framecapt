import {
  MIC_CONSENT_KEY,
  hwndFromSourceId,
  micAppsInUse,
  parseRegQueryOutput,
  type WinInfo,
  type WindowProbe,
} from './window-probe';

interface CapturerSource {
  id: string;
  name: string;
}

export interface FallbackProbeDeps {
  /** Electron's desktopCapturer (or a fake). */
  desktopCapturer: {
    getSources(options: {
      types: ('window' | 'screen')[];
      thumbnailSize: { width: number; height: number };
    }): Promise<CapturerSource[]>;
  };
  /** `child_process.execFile` (or a fake): resolves with stdout. */
  execFile(
    file: string,
    args: string[],
    options: { shell: false; windowsHide: true; timeout: number },
  ): Promise<string>;
  platform: NodeJS.Platform;
}

const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Used when koffi cannot load (blocked native module) or off Windows: window titles from
 * desktopCapturer, the microphone from `reg.exe query` on Windows. It knows nothing about classes,
 * processes, minimized or cloaked windows, or the foreground window.
 */
export class FallbackWindowProbe implements WindowProbe {
  readonly kind = 'fallback' as const;

  constructor(private readonly deps: FallbackProbeDeps) {}

  async list(): Promise<WinInfo[]> {
    const sources = await this.deps.desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const windows: WinInfo[] = [];
    for (const source of sources) {
      const hwnd = hwndFromSourceId(source.id);
      if (hwnd === null) continue;
      windows.push({
        hwnd,
        title: source.name,
        className: '',
        pid: 0,
        exe: '',
        rect: { ...EMPTY_RECT },
        minimized: false,
        visible: true,
        cloaked: false,
      });
    }
    return windows;
  }

  async get(hwnd: string): Promise<WinInfo | null> {
    return (await this.list()).find((window) => window.hwnd === hwnd) ?? null;
  }

  async micInUse(): Promise<string[]> {
    if (this.deps.platform !== 'win32') return [];
    const stdout = await this.deps.execFile(
      'reg.exe',
      ['query', `HKCU\\${MIC_CONSENT_KEY}`, '/s'],
      { shell: false, windowsHide: true, timeout: 3000 },
    );
    return micAppsInUse(parseRegQueryOutput(stdout));
  }

  async foreground(): Promise<string | null> {
    return null;
  }

  dispose(): void {
    // Nothing is held.
  }
}
