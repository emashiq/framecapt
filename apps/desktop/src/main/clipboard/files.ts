import { pathToFileURL } from 'node:url';
import { clipboard, ClipboardItem } from 'electron';

/**
 * Files on the clipboard. Electron 44's clipboard has no raw-format writer (no `writeBuffer`); a
 * `text/uri-list` item (RFC 2483: one `file://` URI per line, CRLF) is turned into the platform's
 * own file list: `CF_HDROP` on Windows (verified: .NET `Clipboard.GetFileDropList` reads it back,
 * see scripts/check-clipboard-files.mjs), a URI list on Linux. Ctrl+V in Explorer, Slack or Outlook
 * then pastes the file.
 */
const URI_LIST = 'text/uri-list';

/** The `text/uri-list` text of these absolute paths. */
export function fileUriList(files: readonly string[]): string {
  return files.map((file) => `${pathToFileURL(file).href}\r\n`).join('');
}

/** Puts these files (or folders) on the clipboard, replacing what was there. */
export async function writeFilesToClipboard(files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  const text = fileUriList(files);
  await clipboard.write([new ClipboardItem({ [URI_LIST]: new Blob([text], { type: URI_LIST }) })]);
}

/** True while the clipboard still holds exactly this file list (nothing else was copied since). */
export async function clipboardHoldsFiles(files: readonly string[]): Promise<boolean> {
  try {
    const [item] = await clipboard.read();
    if (!item?.types.includes(URI_LIST)) return false;
    const blob = await item.getType(URI_LIST);
    return (await blob.text()).trim() === fileUriList(files).trim();
  } catch {
    return false;
  }
}
