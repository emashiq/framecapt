import path from 'node:path';
import { dialog } from 'electron';
import { safeFileStem } from '../../shared/flow';
import { getMainWindow } from '../windows';

const FILTERS = {
  html: { name: 'Web page', extensions: ['html'] },
  mp4: { name: 'MP4 video', extensions: ['mp4'] },
  gif: { name: 'Animated GIF', extensions: ['gif'] },
} as const;

/** The folder dialog of "Images" (a main-process dialog, never a renderer path). */
export async function pickExportFolder(defaultPath: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Save the step pictures to a folder',
    defaultPath,
    buttonLabel: 'Save here',
    properties: ['openDirectory', 'createDirectory'],
  };
  const main = getMainWindow();
  const result = main
    ? await dialog.showOpenDialog(main, options)
    : await dialog.showOpenDialog(options);
  const picked = result.filePaths[0];
  return result.canceled || !picked ? null : picked;
}

/** The save dialog of the HTML guide, the MP4 and the GIF; the chosen name always has the right extension. */
export async function pickGuideSave(
  folder: string,
  options: { defaultName: string; kind: keyof typeof FILTERS },
): Promise<string | null> {
  const filter = FILTERS[options.kind];
  const stem = safeFileStem(options.defaultName.replace(/\.[a-z0-9]+$/i, ''));
  const dialogOptions: Electron.SaveDialogOptions = {
    title: 'Export the step guide',
    defaultPath: path.join(folder, `${stem}.${options.kind}`),
    filters: [{ name: filter.name, extensions: [...filter.extensions] }],
    properties: ['showOverwriteConfirmation'],
  };
  const main = getMainWindow();
  const result = main
    ? await dialog.showSaveDialog(main, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) return null;
  const ext = `.${options.kind}`;
  return path.extname(result.filePath).toLowerCase() === ext
    ? result.filePath
    : `${result.filePath}${ext}`;
}
