# Privacy

This describes what the current build of Framelet (provisional name, beta 0.1.0) actually does. It is a technical statement of behavior, not a legal privacy policy; the project owner may need to add one before a commercial release (see [docs/OWNER-TASKS.md](docs/OWNER-TASKS.md)).

## Summary

- Framelet needs **no account** and collects **no telemetry, analytics or usage data**.
- Framelet makes **no network requests** of its own: no uploads, no cloud processing, no update checks (no update feed is configured in this build). The authors measured this: an automated 60-second run of the UI and a 60-second run of the installed app, including a recording and an MP4 export, produced no non-loopback connection ([docs/packaging.md](docs/packaging.md#network-behavior)). The app also blocks network requests from its own windows.
- Everything you capture stays on your computer, in folders you can see and delete.
- The renderer UI is served locally from inside the app package (`app://framelet`); no web content is loaded.

What happens when a feature that contacts a server is added later (for example an update feed) will be stated here and in the app's About page before that feature ships.

## What is stored, and where

Windows user-profile locations; `%APPDATA%\Framelet` below is Framelet's app-data folder (Electron `userData`).

| What                     | Where                                                                  | Content                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your screenshots         | `%USERPROFILE%\Pictures\Framelet` (or the folder you chose)            | Only files you save: the flattened PNG/JPEG (redactions are baked in)                                                                                                                                 |
| Your recordings, MP4s    | `%USERPROFILE%\Videos\Framelet` (or the folder you chose)              | Finished `.webm` recordings and `.mp4` exports you create. Recordings contain whatever was on screen and the audio you enabled                                                                        |
| Settings                 | `%APPDATA%\Framelet\settings.json`                                     | Your preferences (theme, shortcuts, formats, chosen folders, microphone device id)                                                                                                                    |
| History                  | `%APPDATA%\Framelet\history\history.json`                              | For each saved capture: id, type, date, file path, size, dimensions, duration, format, source kind (screen/window/region), whether it had audio. At most 1000 entries. No window titles               |
| History thumbnails       | `%APPDATA%\Framelet\history\thumbs\<id>.png`                           | Screenshots: drawn from the **flattened** result (redactions applied), at most 480 px wide, never from the unredacted original. Recordings: one frame of the finished recording. Bounded to 200 MB    |
| Editor originals         | `%APPDATA%\Framelet\shots\<id>\original.png`                           | The **unredacted** original screenshot, only while the editor is open (deleted when it closes); leftovers of a crash are swept after 7 days. This folder can therefore briefly hold sensitive content |
| Unfinished recordings    | `%APPDATA%\Framelet\recordings\<id>\` (`manifest.json`, `stream.webm`) | Raw recording data while recording and until it is finished or discarded. After a successful finish this folder is deleted                                                                            |
| Recording records        | `%APPDATA%\Framelet\recordings\completed\<id>.json`                    | Small record (output path, duration, size) kept to link history entries                                                                                                                               |
| Log                      | `%APPDATA%\Framelet\logs\main.log` (and `main.old.log`)                | Diagnostic text only (events, error messages), rotated at 2 MB. **Never capture content or file bytes.** The Windows user name inside paths is replaced by `~`                                        |
| Capture test clips       | `%APPDATA%\Framelet\diagnostics\`                                      | Only if you run **Settings > Advanced** capture checks: short test captures of your screen or audio. They are not deleted automatically; delete them yourself                                         |
| Chromium/Electron data   | `%APPDATA%\Framelet\` (caches, preferences)                            | Standard Electron profile files                                                                                                                                                                       |
| Launch at login (opt-in) | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`                   | A start-up entry, only if you switch "Launch at login" on                                                                                                                                             |

Redaction: black boxes are flattened into the pixels of the saved file, the clipboard image and the thumbnail. Redacted content is not recoverable from those outputs. It is not applied to recordings.

The clipboard: "Copy" puts the (flattened) image on the Windows clipboard, which other apps and Windows clipboard history may read; that is outside Framelet's control.

## What other software may see

- The microphone is used only when you switch it on and Windows' microphone privacy setting allows it. System audio capture records everything played on the default output while recording.
- Installing: Framelet's installer makes no network request (the installer's optional icon download was removed on purpose). Building from source downloads Electron and FFmpeg (SHA-256 pinned) from their publishers.
- The installer is unsigned; Windows SmartScreen may contact Microsoft to check it. That is Windows' behavior, not Framelet's.

## Deleting your data

- **Your captures**: delete the files in your screenshots and recordings folders (or use "Delete file" in History, which moves a file to the Recycle Bin). Uninstalling never deletes them.
- **Framelet's own data**: quit Framelet, then delete `%APPDATA%\Framelet`. This removes settings, history, thumbnails, unfinished recordings, logs and test clips. Uninstalling Framelet keeps this folder on purpose so a reinstall continues where it left off.
- **History only**: remove entries in the History view ("Remove from history" keeps the file; "Clear missing" removes entries whose files are gone).
- **Launch at login**: switch it off in Settings (uninstalling also removes the entry).

## Changes to this statement

Changes are listed in the [CHANGELOG](CHANGELOG.md). Questions: `[OWNER: add privacy contact]`.
