import fs from 'node:fs';
import path from 'node:path';
import {
  applyPatch,
  parseSettings,
  resetSection,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsSchema,
  type OutputTarget,
  type ResetSection,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings';
import {
  EDITOR_ACTIONS,
  SHORTCUT_ACTIONS,
  checkAccelerator,
  checkEditorShortcuts,
  checkShortcuts,
  type ShortcutsMap,
} from '../../shared/shortcuts';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { writeFileAtomic } from '../shots/atomic-write';

export const SETTINGS_FILE = 'settings.json';
/** Changes made within this long of each other are written once. */
export const SETTINGS_DEBOUNCE_MS = 300;

export interface SettingsStoreOptions {
  debounceMs?: number;
  now?: () => number;
  /** Replaceable in tests. */
  write?: (file: string, data: Uint8Array) => Promise<void>;
}

export interface LoadResult {
  existed: boolean;
  /** The file was damaged or invalid: it was moved aside and the defaults are in use. */
  reset: boolean;
}

/**
 * `settings.json` in userData: versioned, validated, written atomically (temp file, fsync, rename)
 * at most once per 300 ms burst. A file that cannot be read or fails validation is moved to
 * `settings.json.corrupt-<time>` and the defaults are used, so it never blocks the app; the UI is
 * told once (`consumeResetNotice`). Reads are synchronous in memory: `get()` is always current.
 */
export class SettingsStore {
  private value: Settings = structuredClone(DEFAULT_SETTINGS);
  private readonly listeners = new Set<(settings: Settings) => void>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writes: Promise<void> = Promise.resolve();
  private resetNotice = false;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly write: (file: string, data: Uint8Array) => Promise<void>;

  constructor(
    private readonly file: string,
    options: SettingsStoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? SETTINGS_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.write = options.write ?? writeFileAtomic;
  }

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { existed: false, reset: false };
      log.warn(`Settings file could not be read (${(error as NodeJS.ErrnoException).code})`);
      return this.setAside('unreadable');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.setAside('not valid JSON');
    }
    const parsed = parseSettings(raw);
    if (!parsed.ok) return this.setAside(parsed.reason);
    this.value = parsed.settings;
    const version = (raw as { version?: unknown } | null)?.version;
    if (version !== SETTINGS_VERSION) this.markDirty(); // an older file: persist the migration
    return { existed: true, reset: false };
  }

  private async setAside(reason: string): Promise<LoadResult> {
    const aside = `${this.file}.corrupt-${this.now()}`;
    await fs.promises.rename(this.file, aside).catch(() => undefined);
    log.warn(`Settings file was invalid (${reason}); it was set aside and the defaults are used`);
    this.value = structuredClone(DEFAULT_SETTINGS);
    this.resetNotice = true;
    return { existed: true, reset: true };
  }

  get(): Settings {
    return this.value;
  }

  /** True once after a damaged file was set aside. */
  consumeResetNotice(): boolean {
    const pending = this.resetNotice;
    this.resetNotice = false;
    return pending;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies a validated change. Throws INVALID_PAYLOAD when the result is not a valid set. */
  update(patch: SettingsPatch): Settings {
    return this.commit(applyPatch(this.value, patch));
  }

  reset(section?: ResetSection): Settings {
    return this.commit(resetSection(this.value, section));
  }

  setOutputDir(target: OutputTarget, dir: string | null): Settings {
    const next = structuredClone(this.value);
    if (target === 'screenshots') next.screenshots.outputDir = dir;
    else next.recording.outputDir = dir;
    return this.commit(next);
  }

  /** Main-owned notices (the tray hint): not part of the renderer's patch. */
  markTrayHintShown(): void {
    if (this.value.notices.trayHintShown) return;
    const next = structuredClone(this.value);
    next.notices.trayHintShown = true;
    this.commit(next);
  }

  private commit(candidate: Settings): Settings {
    const next = structuredClone(candidate);
    // Accelerators are stored in canonical form ("ctrl+shift+1" -> "Ctrl+Shift+1").
    for (const action of SHORTCUT_ACTIONS) {
      const value = next.shortcuts[action];
      if (value === null) continue;
      const parsed = checkAccelerator(value);
      if (!parsed.ok) throw new IpcError('INVALID_PAYLOAD', parsed.reason);
      next.shortcuts[action] = parsed.accelerator;
    }
    for (const action of EDITOR_ACTIONS) {
      const value = next.editorShortcuts[action];
      if (value === null) continue;
      const parsed = checkAccelerator(value, 'app');
      if (!parsed.ok) throw new IpcError('INVALID_PAYLOAD', parsed.reason);
      next.editorShortcuts[action] = parsed.accelerator;
    }
    const valid = SettingsSchema.safeParse(next);
    if (!valid.success) throw new IpcError('INVALID_PAYLOAD', 'Those settings are not valid.');
    const shortcuts = checkShortcuts(valid.data.shortcuts as ShortcutsMap);
    if (!shortcuts.ok) throw new IpcError('INVALID_PAYLOAD', shortcuts.reason);
    const editor = checkEditorShortcuts(valid.data.editorShortcuts);
    if (!editor.ok) throw new IpcError('INVALID_PAYLOAD', editor.reason);
    if (JSON.stringify(valid.data) === JSON.stringify(this.value)) return this.value;
    this.value = valid.data;
    this.markDirty();
    for (const listener of this.listeners) listener(this.value);
    return this.value;
  }

  private markDirty(): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    this.timer.unref();
  }

  get hasPendingWrite(): boolean {
    return this.dirty;
  }

  /** Writes now if anything changed since the last write; resolves when it is on disk. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return this.writes;
    this.dirty = false;
    const body = Buffer.from(`${JSON.stringify(this.value, null, 2)}\n`, 'utf8');
    const write = this.writes.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await this.write(this.file, body);
    });
    // A failed write must not poison the queue; it is logged and retried by the next change.
    this.writes = write.catch((error: unknown) => {
      this.dirty = true;
      log.error('Settings could not be written', error);
    });
    return this.writes;
  }
}
