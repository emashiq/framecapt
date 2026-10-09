/**
 * What the main process can learn about other applications' windows and the microphone, for meeting
 * detection. Electron-free: the Win32 (koffi), fallback (desktopCapturer + reg.exe) and mock
 * implementations all satisfy this interface. Window titles are read in memory only; nothing here
 * stores or logs them.
 */

export interface WinInfo {
  /** Decimal string of the HWND; matches the desktopCapturer id `window:<hwnd>:0`. */
  hwnd: string;
  title: string;
  className: string;
  pid: number;
  /** Lowercase basename of the process image, e.g. `zoom.exe`. Empty when unknown. */
  exe: string;
  rect: { x: number; y: number; width: number; height: number };
  minimized: boolean;
  visible: boolean;
  cloaked: boolean;
}

export interface WindowProbe {
  readonly kind: 'win32' | 'fallback' | 'mock';
  /** Visible top-level windows with a title or a known class (cheap enough to call every 2 s). */
  list(): Promise<WinInfo[]>;
  get(hwnd: string): Promise<WinInfo | null>;
  /**
   * Apps using the microphone right now: lowercase exe basenames (NonPackaged) or package family
   * names (packaged, e.g. `msteams_8wekyb3d8bbwe`).
   */
  micInUse(): Promise<string[]>;
  /** The foreground window's hwnd, or null. */
  foreground(): Promise<string | null>;
  dispose(): void;
}

/** The registry key (under HKCU) whose subkeys record which apps used the microphone. */
export const MIC_CONSENT_KEY =
  'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

/** `window:123:0` -> `123`; null when the id is not a window source id. */
export function hwndFromSourceId(sourceId: string): string | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  return match?.[1] ?? null;
}

/** `123` -> `window:123:0`. */
export function sourceIdFromHwnd(hwnd: string): string {
  return `window:${hwnd}:0`;
}

/**
 * A ConsentStore subkey name to an app identity. A NonPackaged key is an exe path with `\` replaced
 * by `#` (`C:#Program Files#Zoom#bin#Zoom.exe` -> `zoom.exe`); a packaged key is a package family
 * name, only lowercased.
 */
export function parseConsentStoreKeyName(name: string): string {
  const base = name.includes('#') ? (name.split('#').pop() ?? name) : name;
  return base.toLowerCase();
}

/** The app is using the microphone when a session started and has not stopped (FILETIME values). */
export function isMicInUse(lastUsedTimeStart: bigint, lastUsedTimeStop: bigint): boolean {
  return lastUsedTimeStop === 0n && lastUsedTimeStart !== 0n;
}

export interface ConsentEntry {
  /** The full key path as `reg query` prints it. */
  key: string;
  lastUsedTimeStart: bigint;
  lastUsedTimeStop: bigint;
}

/**
 * Parses `reg query <key> /s` output: a key path line (starts with HKEY_) followed by indented
 * `Name  TYPE  data` lines. Only keys that carry a LastUsedTimeStart or LastUsedTimeStop REG_QWORD
 * are returned; a missing one counts as 0.
 */
export function parseRegQueryOutput(stdout: string): ConsentEntry[] {
  const entries: ConsentEntry[] = [];
  let current: ConsentEntry | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('HKEY_')) {
      current = { key: line.trim(), lastUsedTimeStart: 0n, lastUsedTimeStop: 0n };
      entries.push(current);
      continue;
    }
    const value =
      /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-fA-F]+)\s*$/.exec(line);
    if (!current || !value) continue;
    const parsed = BigInt(value[2] as string);
    if (value[1] === 'LastUsedTimeStart') current.lastUsedTimeStart = parsed;
    else current.lastUsedTimeStop = parsed;
  }
  return entries.filter((entry) => entry.lastUsedTimeStart !== 0n || entry.lastUsedTimeStop !== 0n);
}

/** App identities (deduplicated, lowercase) of the entries that are using the microphone now. */
export function micAppsInUse(entries: readonly ConsentEntry[]): string[] {
  const apps = new Set<string>();
  for (const entry of entries) {
    if (!isMicInUse(entry.lastUsedTimeStart, entry.lastUsedTimeStop)) continue;
    const name = entry.key.split('\\').pop() ?? '';
    if (name !== '') apps.add(parseConsentStoreKeyName(name));
  }
  return [...apps];
}
