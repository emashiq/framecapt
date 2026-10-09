import { createRequire } from 'node:module';
import path from 'node:path';
import type * as KoffiModule from 'koffi';
import {
  MIC_CONSENT_KEY,
  micAppsInUse,
  type ConsentEntry,
  type WinInfo,
  type WindowProbe,
} from './window-probe';

type Koffi = typeof KoffiModule;

// The main bundle is CommonJS (`import.meta` does not exist there); vitest provides __filename too.
const nodeRequire = createRequire(__filename);

/** Loads koffi (an external module, shipped next to the app; see forge.config.ts). Throws when it cannot load. */
export function loadKoffi(): Koffi {
  const loaded = nodeRequire('koffi') as Koffi & { default?: Koffi };
  return loaded.default ?? loaded;
}

const HKEY_CURRENT_USER = 0x80000001;
const KEY_READ = 0x20019;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_CLOAKED = 14;
const ERROR_SUCCESS = 0;
const MAX_TEXT = 512;
const MAX_PATH_CHARS = 1024;

export interface Win32ProbeOptions {
  /** Window classes to include even when the window has no title. */
  classAllowlist?: readonly string[];
}

function decodeUtf16(buffer: Uint16Array, chars: number): string {
  return Buffer.from(buffer.buffer, buffer.byteOffset, Math.max(0, chars) * 2).toString('utf16le');
}

/** Declares every Win32 function the probe uses. */
function bindApi(koffi: Koffi) {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const advapi32 = koffi.load('advapi32.dll');
  koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const enumProc = koffi.proto('bool __stdcall FrameCaptEnumProc(intptr_t hwnd, intptr_t lparam)');
  return {
    koffi,
    enumProc,
    enumWindows: user32.func('bool __stdcall EnumWindows(FrameCaptEnumProc *cb, intptr_t lparam)'),
    getWindowTextLength: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
    getWindowText: user32.func(
      'int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *text, int max)',
    ),
    getClassName: user32.func(
      'int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *text, int max)',
    ),
    getWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)',
    ),
    isIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    isWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    isWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
    getWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)'),
    getForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    openProcess: kernel32.func(
      'intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)',
    ),
    queryImageName: kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)',
    ),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t handle)'),
    dwmGetWindowAttribute: dwmapi.func(
      'long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attribute, _Out_ int32_t *value, uint32_t size)',
    ),
    regOpenKey: advapi32.func(
      'long __stdcall RegOpenKeyExW(uintptr_t key, str16 subKey, uint32_t options, uint32_t access, _Out_ uintptr_t *result)',
    ),
    regEnumKey: advapi32.func(
      'long __stdcall RegEnumKeyExW(uintptr_t key, uint32_t index, _Out_ uint16_t *name, _Inout_ uint32_t *nameLength, void *reserved, void *cls, void *classLength, void *lastWrite)',
    ),
    regQueryValue: advapi32.func(
      'long __stdcall RegQueryValueExW(uintptr_t key, str16 valueName, void *reserved, _Out_ uint32_t *type, _Out_ uint8_t *data, _Inout_ uint32_t *size)',
    ),
    regCloseKey: advapi32.func('long __stdcall RegCloseKey(uintptr_t key)'),
  };
}

let boundApi: ReturnType<typeof bindApi> | undefined;

/**
 * The Win32 probe: user32/kernel32/dwmapi/advapi32 through koffi, called synchronously in the main
 * process (each call is microseconds) and exposed as promises. Throws from the constructor when
 * koffi or a system library cannot be loaded (for example when application control blocks
 * koffi.node); createWindowProbe then falls back.
 */
export class Win32WindowProbe implements WindowProbe {
  readonly kind = 'win32' as const;
  private readonly classAllowlist: ReadonlySet<string>;
  private readonly ownExe = path.basename(process.execPath).toLowerCase();
  private readonly exeByPid = new Map<number, string>();
  private readonly api: ReturnType<typeof bindApi>;

  constructor(options: Win32ProbeOptions = {}) {
    this.classAllowlist = new Set(options.classAllowlist ?? []);
    // koffi types (RECT, the callback prototype) can be declared once per process.
    boundApi ??= bindApi(loadKoffi());
    this.api = boundApi;
  }

  list(): Promise<WinInfo[]> {
    try {
      return Promise.resolve(this.listSync());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  get(hwnd: string): Promise<WinInfo | null> {
    try {
      const handle = Number(hwnd);
      if (!Number.isSafeInteger(handle) || !this.api.isWindow(handle)) return Promise.resolve(null);
      return Promise.resolve(this.describe(handle));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  micInUse(): Promise<string[]> {
    try {
      const apps = micAppsInUse(this.readConsentEntries());
      return Promise.resolve(apps.filter((app) => app !== this.ownExe));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  foreground(): Promise<string | null> {
    try {
      const handle = this.api.getForegroundWindow() as number;
      return Promise.resolve(handle ? String(handle) : null);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    this.exeByPid.clear();
  }

  private listSync(): WinInfo[] {
    const { koffi, enumProc, enumWindows } = this.api;
    const handles: number[] = [];
    const callback = koffi.register((hwnd: number) => {
      handles.push(hwnd);
      return true;
    }, koffi.pointer(enumProc));
    try {
      enumWindows(callback, 0);
    } finally {
      koffi.unregister(callback);
    }
    const windows: WinInfo[] = [];
    const seenPids = new Set<number>();
    for (const handle of handles) {
      if (!this.api.isWindowVisible(handle) && !this.api.isIconic(handle)) continue;
      const info = this.describe(handle);
      seenPids.add(info.pid);
      if (info.pid === process.pid) continue;
      if (info.title === '' && !this.classAllowlist.has(info.className)) continue;
      windows.push(info);
    }
    // pids are reused: forget the ones no listed window has now.
    for (const pid of this.exeByPid.keys()) if (!seenPids.has(pid)) this.exeByPid.delete(pid);
    return windows;
  }

  private describe(handle: number): WinInfo {
    const api = this.api;
    const pidOut = [0];
    api.getWindowThreadProcessId(handle, pidOut);
    const pid = pidOut[0] ?? 0;
    const rect: { left?: number; top?: number; right?: number; bottom?: number } = {};
    api.getWindowRect(handle, rect);
    const left = rect.left ?? 0;
    const top = rect.top ?? 0;
    const cloakedOut = [0];
    const cloaked =
      api.dwmGetWindowAttribute(handle, DWMWA_CLOAKED, cloakedOut, 4) === ERROR_SUCCESS &&
      (cloakedOut[0] ?? 0) !== 0;
    return {
      hwnd: String(handle),
      title: this.windowText(handle),
      className: this.className(handle),
      pid,
      exe: this.exeOf(pid),
      rect: { x: left, y: top, width: (rect.right ?? 0) - left, height: (rect.bottom ?? 0) - top },
      minimized: Boolean(api.isIconic(handle)),
      visible: Boolean(api.isWindowVisible(handle)),
      cloaked,
    };
  }

  private windowText(handle: number): string {
    const length = this.api.getWindowTextLength(handle) as number;
    if (length <= 0) return '';
    const buffer = new Uint16Array(Math.min(length, MAX_TEXT) + 1);
    return decodeUtf16(buffer, this.api.getWindowText(handle, buffer, buffer.length) as number);
  }

  private className(handle: number): string {
    const buffer = new Uint16Array(256);
    return decodeUtf16(buffer, this.api.getClassName(handle, buffer, buffer.length) as number);
  }

  private exeOf(pid: number): string {
    const cached = this.exeByPid.get(pid);
    if (cached !== undefined) return cached;
    let exe = '';
    const handle =
      pid > 0 ? (this.api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number) : 0;
    if (handle) {
      try {
        const buffer = new Uint16Array(MAX_PATH_CHARS);
        const size = [buffer.length];
        if (this.api.queryImageName(handle, 0, buffer, size)) {
          exe = path.win32.basename(decodeUtf16(buffer, size[0] ?? 0)).toLowerCase();
        }
      } finally {
        this.api.closeHandle(handle);
      }
    }
    // A process that could not be opened (elevated, protected) stays unknown; do not cache it so a
    // later list can still resolve it.
    if (exe !== '') this.exeByPid.set(pid, exe);
    return exe;
  }

  /** Every ConsentStore microphone subkey (packaged apps directly, NonPackaged apps one level down) with its two timestamps. */
  private readConsentEntries(): ConsentEntry[] {
    const root = this.openKey(HKEY_CURRENT_USER, MIC_CONSENT_KEY);
    if (root === null) return [];
    const entries: ConsentEntry[] = [];
    try {
      for (const name of this.subKeyNames(root)) {
        if (name === 'NonPackaged') {
          const nonPackaged = this.openKey(root, name);
          if (nonPackaged === null) continue;
          try {
            for (const child of this.subKeyNames(nonPackaged)) {
              this.pushEntry(entries, nonPackaged, child);
            }
          } finally {
            this.api.regCloseKey(nonPackaged);
          }
        } else {
          this.pushEntry(entries, root, name);
        }
      }
    } finally {
      this.api.regCloseKey(root);
    }
    return entries;
  }

  private pushEntry(entries: ConsentEntry[], parent: number, name: string): void {
    const key = this.openKey(parent, name);
    if (key === null) return;
    try {
      entries.push({
        key: name,
        lastUsedTimeStart: this.readQword(key, 'LastUsedTimeStart'),
        lastUsedTimeStop: this.readQword(key, 'LastUsedTimeStop'),
      });
    } finally {
      this.api.regCloseKey(key);
    }
  }

  private openKey(parent: number, subKey: string): number | null {
    const out = [0];
    return this.api.regOpenKey(parent, subKey, 0, KEY_READ, out) === ERROR_SUCCESS
      ? (out[0] ?? null)
      : null;
  }

  private subKeyNames(key: number): string[] {
    const names: string[] = [];
    for (let index = 0; index < 4096; index++) {
      const buffer = new Uint16Array(MAX_PATH_CHARS);
      const length = [buffer.length];
      const status = this.api.regEnumKey(key, index, buffer, length, null, null, null, null);
      if (status !== ERROR_SUCCESS) break;
      names.push(decodeUtf16(buffer, length[0] ?? 0));
    }
    return names;
  }

  /** A REG_QWORD value; 0n when it is missing or not 8 bytes. */
  private readQword(key: number, name: string): bigint {
    const data = Buffer.alloc(8);
    const size = [data.length];
    const status = this.api.regQueryValue(key, name, null, [0], data, size);
    return status === ERROR_SUCCESS && size[0] === 8 ? data.readBigUInt64LE(0) : 0n;
  }
}
