# Privacy

This describes what the current build of FrameCapt (provisional name, beta 0.1.0) actually does. It is a technical statement of behavior, not a legal privacy policy; the project owner may need to add one before a commercial release (see [docs/OWNER-TASKS.md](docs/OWNER-TASKS.md)).

## Summary

- FrameCapt has **no account and no account service**. It collects **no telemetry, analytics or usage data**.
- Captures are **never uploaded**: no cloud storage, no sharing links, no cloud processing. Nothing leaves your computer: the app makes no network requests of its own (no update feed is configured) and blocks network requests from its own windows. This was measured with 60-second runs of the UI and of the installed app, including a recording and an MP4 export, with no non-loopback connection ([docs/packaging.md](docs/packaging.md#network-behavior)).
- Everything you capture stays on your computer, in folders you can see and delete.
- The renderer UI is served locally from inside the app package (`app://framecapt`); no web content is loaded.

If a feature that contacts a server is added later (for example an update feed), it will be stated here and in the app's About page before that feature ships.

## What is stored, and where

Windows user-profile locations; `%APPDATA%\FrameCapt` below is FrameCapt's app-data folder (Electron `userData`).

| What                     | Where                                                                   | Content                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your screenshots         | `%USERPROFILE%\Pictures\FrameCapt` (or the folder you chose)            | Only files you save: the flattened PNG/JPEG (redactions are baked in)                                                                                                                                 |
| Your recordings, MP4s    | `%USERPROFILE%\Videos\FrameCapt` (or the folder you chose)              | Finished `.webm` recordings and `.mp4` exports you create. Recordings contain whatever was on screen and the audio you enabled                                                                        |
| Settings                 | `%APPDATA%\FrameCapt\settings.json`                                     | Your preferences (theme, shortcuts, formats, chosen folders, microphone device id)                                                                                                                    |
| History                  | `%APPDATA%\FrameCapt\history\history.json`                              | For each saved capture: id, type, date, file path, size, dimensions, duration, format, source kind (screen/window/region), whether it had audio. At most 1000 entries. No window titles               |
| History thumbnails       | `%APPDATA%\FrameCapt\history\thumbs\<id>.png`                           | Screenshots: drawn from the **flattened** result (redactions applied), at most 480 px wide, never from the unredacted original. Recordings: one frame of the finished recording. Bounded to 200 MB    |
| Editable projects        | `%APPDATA%\FrameCapt\projects\<id>\` (`original.png`, `project.json`)    | Kept while **Keep editable originals** is on (the default): the **unredacted** original and the annotations of each saved screenshot, so it can be edited again from History. Deleted with the history item, by "Delete editable data" in the item's details, or never created when the setting is off |
| Editor originals         | `%APPDATA%\FrameCapt\shots\<id>\original.png`                           | The **unredacted** original screenshot, only while the editor is open (deleted when it closes); leftovers of a crash are swept after 7 days. This folder can therefore briefly hold sensitive content |
| Unfinished recordings    | `%APPDATA%\FrameCapt\recordings\<id>\` (`manifest.json`, `stream.webm`) | Raw recording data while recording and until it is finished or discarded. After a successful finish this folder is deleted                                                                            |
| Recording records        | `%APPDATA%\FrameCapt\recordings\completed\<id>.json`                    | Small record (output path, duration, size) kept to link history entries                                                                                                                               |
| Log                      | `%APPDATA%\FrameCapt\logs\main.log` (and `main.old.log`)                | Diagnostic text only (events, error messages), rotated at 2 MB. **Never capture content or file bytes.** The Windows user name inside paths is replaced by `~`                                        |
| Capture test clips       | `%APPDATA%\FrameCapt\diagnostics\`                                      | Only if you run **Settings > Advanced** capture checks: short test captures of your screen or audio. They are not deleted automatically; delete them yourself                                         |
| Chromium/Electron data   | `%APPDATA%\FrameCapt\` (caches, preferences)                            | Standard Electron profile files                                                                                                                                                                       |
| Launch at login (opt-in) | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`                    | A start-up entry, only if you switch "Launch at login" on                                                                                                                                             |

Redaction: black boxes are flattened into the pixels of the saved file, the clipboard image and the thumbnail. Redacted content is not recoverable from those outputs. It is not applied to recordings.

The clipboard: "Copy" puts the (flattened) image on the Windows clipboard, which other apps and Windows clipboard history may read; that is outside FrameCapt's control.

## What other software may see

- The microphone is used only when you switch it on and Windows' microphone privacy setting allows it. System audio capture records everything played on the default output while recording.
- Installing: FrameCapt's installer makes no network request (the installer's optional icon download was removed on purpose). Building from source downloads Electron and FFmpeg (SHA-256 pinned) from their publishers.
- The installer is unsigned; Windows SmartScreen may contact Microsoft to check it. That is Windows' behavior, not FrameCapt's.

## Deleting your data

- **Your captures**: delete the files in your screenshots and recordings folders (or use "Delete file" in the Library, which moves a file to the Recycle Bin). Uninstalling never deletes them.
- **FrameCapt's own data**: quit FrameCapt, then delete `%APPDATA%\FrameCapt`. This removes settings, history, thumbnails, unfinished recordings, logs and test clips. Uninstalling FrameCapt keeps this folder on purpose so a reinstall continues where it left off.
- **History only**: remove entries in the Library ("Remove from history" keeps the file; "Clear missing" removes entries whose files are gone).
- **Launch at login**: switch it off in Settings (uninstalling also removes the entry).

## Changes to this statement

Changes are listed in the [CHANGELOG](CHANGELOG.md). Questions: `[OWNER: add privacy contact]`.
