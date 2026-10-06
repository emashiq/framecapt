import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { friendlyError } from '../../shared/error-messages';
import {
  DEFAULT_SETTINGS,
  applyPatch,
  patchFromRecordOptions,
  type EffectiveSettings,
  type OutputTarget,
  type ResetSection,
  type Settings,
  type SettingsPatch,
  type SettingsState,
} from '../../shared/settings';
import { SHORTCUT_ACTIONS, type ShortcutStates } from '../../shared/shortcuts';
import { announce } from '../lib/announce';
import { clearLegacyRecordOptions, loadLegacyRecordOptions } from '../recorder/legacy-options';

/**
 * The renderer's copy of the settings. Main owns the file; this mirrors it (loaded once, then every
 * `settings:changed`), applies a change at once and lets main's answer have the last word. Kept
 * outside React so every component reads the same state.
 */
let state: SettingsState | null = null;
let shortcutStates: ShortcutStates | null = null;
let savedVisible = false;
let savedTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyTheme(theme: Settings['general']['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function setState(next: SettingsState): void {
  state = next;
  applyTheme(next.settings.general.theme);
  emit();
}

const DEFAULT_EFFECTIVE: EffectiveSettings = { screenshotsDir: '', recordingsDir: '' };

export function useSettingsState(): SettingsState | null {
  useSyncExternalStore(subscribe, () => version);
  return state;
}

/** The settings (the defaults until the first load answered, see `useSettingsLoaded`). */
export function useSettings(): Settings {
  return useSettingsState()?.settings ?? DEFAULT_SETTINGS;
}

export function useEffectiveDirs(): EffectiveSettings {
  return useSettingsState()?.effective ?? DEFAULT_EFFECTIVE;
}

export function useSettingsLoaded(): boolean {
  return useSettingsState() !== null;
}

export function useShortcutStates(): ShortcutStates | null {
  useSyncExternalStore(subscribe, () => version);
  return shortcutStates;
}

/** True for a moment after a successful change (the "Saved" indicator). */
export function useSavedVisible(): boolean {
  useSyncExternalStore(subscribe, () => version);
  return savedVisible;
}

export function getSettings(): Settings {
  return state?.settings ?? DEFAULT_SETTINGS;
}

function failed(error: { code: string; message: string }): void {
  toast.error(friendlyError(error.code, error.message));
}

function markSaved(): void {
  savedVisible = true;
  announce('Saved');
  emit();
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedVisible = false;
    emit();
  }, 2200);
}

/** Applies a change now and sends it to main. Returns false (and says why) when main refused it. */
export async function updateSettings(patch: SettingsPatch): Promise<boolean> {
  const before = state;
  if (before) setState({ ...before, settings: applyPatch(before.settings, patch) });
  const response = await window.framecapt.invoke('settings:update', { patch });
  if (!response.ok) {
    if (before) setState(before);
    failed(response.error);
    return false;
  }
  setState(response.data);
  markSaved();
  return true;
}

export async function resetSettings(section?: ResetSection): Promise<void> {
  const response = await window.framecapt.invoke('settings:reset', section ? { section } : {});
  if (!response.ok) return failed(response.error);
  setState(response.data);
  markSaved();
}

export async function chooseOutputDir(target: OutputTarget): Promise<void> {
  const response = await window.framecapt.invoke('settings:chooseOutputDir', { target });
  if (!response.ok) return failed(response.error);
  setState(response.data.state);
  if (response.data.changed) markSaved();
}

export async function resetOutputDir(target: OutputTarget): Promise<void> {
  const response = await window.framecapt.invoke('settings:useDefaultOutputDir', { target });
  if (!response.ok) return failed(response.error);
  setState(response.data);
  markSaved();
}

/** The phase-05 record options lived in localStorage: carry them over once, then stop using it. */
async function migrateLegacyRecordOptions(): Promise<void> {
  const legacy = loadLegacyRecordOptions();
  if (!legacy) return;
  const response = await window.framecapt.invoke('settings:update', {
    patch: patchFromRecordOptions(legacy),
  });
  if (response.ok) {
    setState(response.data);
    clearLegacyRecordOptions();
  }
}

/** Loads the settings and follows main's changes. Call once from the app root; returns the cleanup. */
export function startSettingsSync(): () => void {
  let live = true;
  const offs = [
    window.framecapt.on('settings:changed', (next) => setState(next)),
    window.framecapt.on('shortcuts:changed', (next) => {
      shortcutStates = next;
      emit();
    }),
  ];
  void window.framecapt.invoke('settings:get').then(async (response) => {
    if (!live) return;
    if (!response.ok) return failed(response.error);
    setState(response.data);
    await migrateLegacyRecordOptions();
  });
  void window.framecapt.invoke('shortcuts:status').then((response) => {
    if (live && response.ok) {
      shortcutStates = response.data;
      emit();
    }
  });
  void window.framecapt.invoke('settings:consumeNotice').then((response) => {
    if (live && response.ok && response.data.reset) {
      toast('Settings were reset because the file was damaged. Your captures were not touched.', {
        duration: 10_000,
      });
    }
  });
  return () => {
    live = false;
    offs.forEach((off) => off());
  };
}

/** How many shortcuts that are set could not be registered (the warning on the home view). */
export function problemCount(states: ShortcutStates | null): number {
  if (!states) return 0;
  return SHORTCUT_ACTIONS.filter(
    (action) => states[action].status === 'conflict' || states[action].status === 'invalid',
  ).length;
}
