import fs from 'node:fs';
import { dialog, shell } from 'electron';
import {
  checkAccelerator,
  actionUsing,
  type ShortcutStates,
  SHORTCUT_LABELS,
} from '../../shared/shortcuts';
import type { OutputTarget, SettingsState } from '../../shared/settings';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { ShortcutManager } from '../shortcuts';
import { getMainWindow } from '../windows';
import type { AppSettings } from './index';
import { probeWritable } from './output-dirs';

function stateOf(settings: AppSettings): SettingsState {
  return { settings: settings.store.get(), effective: settings.dirs() };
}

function folderOf(settings: AppSettings, target: OutputTarget): string {
  const dirs = settings.dirs();
  return target === 'screenshots' ? dirs.screenshotsDir : dirs.recordingsDir;
}

/**
 * Settings and shortcut channels. Output folders are only ever set here, from a main-process folder
 * dialog and after a write probe: the renderer's patch cannot carry a path.
 */
export function registerSettingsHandlers(settings: AppSettings, shortcuts: ShortcutManager): void {
  const { store } = settings;
  handle('settings:get', { roles: ['main'] }, () => stateOf(settings));
  handle('settings:update', { roles: ['main'] }, (request) => {
    store.update(request.patch);
    return stateOf(settings);
  });
  handle('settings:reset', { roles: ['main'] }, (request) => {
    store.reset(request.section);
    return stateOf(settings);
  });
  handle('settings:consumeNotice', { roles: ['main'] }, () => ({
    reset: store.consumeResetNotice(),
  }));

  handle('settings:chooseOutputDir', { roles: ['main'] }, async (request) => {
    const options: Electron.OpenDialogOptions = {
      title: request.target === 'screenshots' ? 'Screenshots folder' : 'Recordings folder',
      defaultPath: folderOf(settings, request.target),
      properties: ['openDirectory', 'createDirectory'],
    };
    const main = getMainWindow();
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { changed: false, state: stateOf(settings) };
    if (!(await probeWritable(picked))) {
      log.warn('A chosen output folder was refused: not writable');
      throw new IpcError(
        'OUTPUT_DIR_UNWRITABLE',
        "FrameCapt can't save to that folder. Choose a folder you can write to.",
      );
    }
    store.setOutputDir(request.target, picked);
    return { changed: true, state: stateOf(settings) };
  });
  handle('settings:useDefaultOutputDir', { roles: ['main'] }, (request) => {
    store.setOutputDir(request.target, null);
    return stateOf(settings);
  });
  handle('settings:openOutputDir', { roles: ['main'] }, async (request) => {
    const folder = folderOf(settings, request.target);
    await fs.promises.mkdir(folder, { recursive: true });
    const failure = await shell.openPath(folder);
    if (failure) throw new IpcError('INTERNAL', 'The folder could not be opened.');
  });

  handle('shortcuts:status', { roles: ['main'] }, (): ShortcutStates => shortcuts.status());
  handle('shortcuts:validate', { roles: ['main'] }, (request) => {
    if (request.accelerator === null) return { ok: true as const, accelerator: null };
    const parsed = checkAccelerator(request.accelerator);
    if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
    const holder = actionUsing(store.get().shortcuts, parsed.accelerator, request.action);
    if (holder) {
      return {
        ok: false as const,
        reason: `${parsed.accelerator} is already used by “${SHORTCUT_LABELS[holder]}”.`,
      };
    }
    return { ok: true as const, accelerator: parsed.accelerator };
  });
  handle('shortcuts:setPaused', { roles: ['main'] }, (request) => {
    shortcuts.setPaused(request.paused);
  });
}
