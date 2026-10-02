# Framelet user guide

Framelet (provisional name, beta 0.1.0) captures screenshots and screen recordings on Windows and keeps everything on your computer. This guide describes what the current build does. For the list of default shortcuts see [keyboard-shortcuts.md](keyboard-shortcuts.md).

Contents: [Screenshots](#screenshots) - [The editor](#the-editor) - [Redaction](#redaction) - [Recording](#recording) - [Unfinished recordings](#unfinished-recordings) - [Export to MP4](#export-to-mp4) - [History](#history) - [Settings](#settings) - [Tray](#tray) - [Troubleshooting](#troubleshooting)

## Screenshots

Start from the home screen (**Capture > Screenshot**) or from a global shortcut:

- **Screen** (`Ctrl+Shift+1`): with one display the capture happens at once. With several displays, a translucent overlay appears on each; click the display you want (or press `Enter`). The image is the display's full physical resolution.
- **Window** (`Ctrl+Shift+2`): a picker lists the open windows (search or arrow keys). The window's visible frame and title bar are included; minimized windows are not listed.
- **Region** (`Ctrl+Shift+3`): the screen freezes under an overlay; drag a rectangle, move it, resize it with the handles, or use the keyboard (arrow keys start a centered selection, `Shift` moves 10 px, `Alt` resizes, `Enter` captures, `Esc` or right click cancels). A region stays on **one** monitor.

After a capture the screenshot opens in the editor (Settings > Screenshots > "After a capture" can also copy it to the clipboard or save it first). The selection overlay, pill and dim layer are never part of the image.

Save with `Ctrl+S` (PNG or JPEG, your choice in Settings; you pick the file name in a save dialog) or copy with `Ctrl+C` (image to the clipboard). Saved screenshots go to `Pictures\Framelet` unless you changed the folder.

## The editor

| Tool      | Key | What it does                                                 |
| --------- | --- | ------------------------------------------------------------ |
| Select    | `V` | Select, move and resize marks; `Delete` removes the selected |
| Crop      | `C` | Drag to crop (non-destructive until you save)                |
| Arrow     | `A` | Drag to draw an arrow                                        |
| Rectangle | `R` | Drag to draw a rectangle                                     |
| Text      | `T` | Click to add text                                            |
| Redact    | `X` | Drag to cover an area with solid black                       |

Other keys: `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo (200 steps), `Ctrl+=` / `Ctrl+-` zoom, `Ctrl+0` fit, `Ctrl+1` 100%, arrow keys move the selected mark. Closing the editor with unsaved changes asks first. The unedited original is kept in Framelet's app-data folder only while the editor is open (it is deleted when the editor closes; unfinished leftovers older than 7 days are swept).

## Redaction

The Redact tool paints **solid, opaque black** over the area. Guarantees, each checked in automated tests on real pixels:

- Redactions are drawn **last**, on top of arrows, rectangles and text, so nothing can sit above them.
- They are **flattened into the exported pixels**: the saved PNG or JPEG, the clipboard image and the history thumbnail contain the black pixels, not an overlay or a layer. There is no way to "un-redact" a saved file.
- A redaction is expanded by 1 px; for JPEG it is padded to the 16 px block grid (about 2 px more) because JPEG compression would otherwise let faint traces of the covered content leak near the edges.
- The history thumbnail of a screenshot is drawn from the flattened result, never from the original capture.

Limits to be aware of: redaction protects what you cover in the image you export. It does not remove sensitive text that you forgot to cover, and it does not edit recordings (there is no video redaction).

## Recording

Start from **Capture > Record** or a shortcut: **Screen** (`Ctrl+Shift+5`), **Window** (`Ctrl+Shift+6`), **Region** (`Ctrl+Shift+7`; one monitor only). The recording options on the home screen (and in Settings > Recording):

- **Quality**: 1080p (fits the picture inside 1920 x 1080) or Source (the full resolution of the screen, larger files).
- **Frame rate**: 30 (default) or 60. 60 needs a faster computer and was not benchmarked over long recordings.
- **Microphone** and **System audio** are separate switches. If both are on they are mixed into one audio track; muting either is available on the toolbar. The microphone device can be chosen. System audio is everything Windows plays on the default output.
- **Countdown**: a 3-2-1 countdown before recording starts (on by default).
- **Also save an MP4**: converts every finished recording to MP4 next to the original (off by default).

While recording, a small floating **toolbar** shows the timer and status with Pause/Resume, Mute buttons and Stop. The toolbar and the countdown are excluded from the recording (verified on the test machine through Windows' content-protection setting; this exclusion is a platform behavior, so do not rely on it for anything security-critical). Paused time is not recorded. Stop with the toolbar, the main window, the tray menu, or `Ctrl+Shift+0` (pressing the record shortcut again also stops).

Recordings are written to disk **while** you record (bounded memory, a 30-minute 1080p30 recording was benchmarked: [performance.md](performance.md)) and finished into a seekable `.webm` (VP9 video, Opus audio) in `Videos\Framelet`, named `Framelet YYYY-MM-DD at HH.mm.ss.webm`. Existing files are never overwritten.

If the disk gets low, Framelet refuses to start below 1 GB free and stops safely (keeping what was recorded) below 500 MB free. If a source disappears (a window closes, a device is lost) the recording stops and what was captured is saved.

Quitting while recording asks first; if you quit, Framelet stops and finishes the recording (up to 15 seconds; otherwise it finishes at the next start).

## Unfinished recordings

If Framelet or Windows ends abruptly during a recording (crash, forced kill, power loss), the next start shows a card: "We found an unfinished recording" with **Recover** and **Discard**. Recovery is **best effort, not lossless**:

- In forced-process-kill tests, the recovered file lacked up to about 0.7 s at the end (the unsent second of media plus the in-flight chunk); that was three runs on one machine, not a guarantee.
- After a power cut or Windows crash, data still in the OS write cache may be missing; this was not tested.
- If the very start of the file (its header) is missing, the recording cannot be repaired; Framelet says so and keeps the raw data for diagnostics.

"Discard" deletes only that unfinished session after you confirm. Details: [recording-persistence.md](recording-persistence.md).

## Export to MP4

Recordings are saved as WebM. For a recording in History (or on the result screen) choose **Export MP4**: pick a destination, watch the progress, and cancel if you like. The conversion is real (H.264 video and AAC audio, with the index at the start of the file); a file is never just renamed. A cancelled or failed export leaves your original untouched and no partial file behind. If the bundled FFmpeg cannot do H.264/AAC, the app says MP4 export is unavailable and the WebM remains your file. One export runs at a time.

## History

**History** lists screenshots and recordings you saved (the newest six also appear on the home screen). Filter All / Screenshots / Recordings, search by name, date or type, press `Enter` to open the details, where you can open the file, show it in its folder, copy the image or the path, export MP4, save a copy of a recording, or remove it.

- **Remove from history** removes only the list entry (with a 5-second Undo). It never touches your file.
- **Delete file** is a separate, confirmed action that moves the file to the **Recycle Bin**.
- If a file was moved or deleted outside Framelet, the entry stays listed as "File moved or deleted" with **Locate...** to point it at the new place, **Remove**, or **Clear missing**.
- History keeps at most 1000 entries (older entries drop off the list; their files are never touched). It stores metadata and thumbnails only.

## Settings

Sections: **General** (theme: follow Windows / light / dark; launch at login; close to tray; notifications), **Screenshots** (format, JPEG quality, what happens after a capture, copy on save), **Recording** (quality, frame rate, countdown, microphone and device, system audio, also save MP4), **Shortcuts** (change or turn off each global shortcut; conflicts are shown), **Storage** (screenshots and recordings folders, chosen with a folder dialog and checked for write access), **Advanced** (capture diagnostics for troubleshooting), **About** (version and update status; updates are "Not configured for this build"). Each section can be reset. Settings are stored in `%APPDATA%\Framelet\settings.json`.

## Tray

Framelet keeps one tray icon (a red dot while recording) with a menu for the capture actions. By default, closing the main window keeps Framelet running in the tray so global shortcuts keep working (a one-time notification explains this); turn "Close to tray" off to quit on close. "Launch at login" (off by default) starts Framelet hidden in the tray, and only works in the installed app. Quit from the tray menu.

## Troubleshooting

- **Protected content is black.** Windows does not let apps capture DRM-protected video (for example streaming services in a browser); that area is black in screenshots and recordings. This is a Windows platform behavior.
- **A window is missing from the list.** Minimized windows are not offered by Windows' capture API. Restore the window and pick it again.
- **System audio is unavailable.** Recording requires Windows' loopback audio. If no audio track arrives, Framelet shows an error and does not start the recording; try again, check your default output device, or record without system audio. (Changing the default output device during a recording was not tested.)
- **The microphone is silent or lost.** Check Windows microphone privacy settings and the selected device. If the microphone (or system audio) ends while recording, the toolbar shows a "Microphone disconnected" / "System audio ended" badge. (Unplugging a microphone mid-recording was exercised in tests with injected events, not with real hardware.)
- **A shortcut does not work.** Another app may own that key combination. Settings > Shortcuts shows "used by another app"; pick a different one. `Ctrl+Shift+0` may collide with Windows input-language hotkeys on some systems.
- **Low disk space.** Free some space; recording will not start below 1 GB free on the drive that holds `%APPDATA%\Framelet`, and stops safely below 500 MB.
- **Windows SmartScreen warns on the installer.** The installer is not code-signed yet (see [packaging.md](packaging.md)). Only run it if you obtained it from a source you trust and its SHA-256 matches.
- **Where are my files?** Screenshots: `Pictures\Framelet` (or the folder you chose). Recordings and MP4 exports: `Videos\Framelet`. Settings, history, unfinished sessions and logs: `%APPDATA%\Framelet`. See [../PRIVACY.md](../PRIVACY.md).
- **Reporting a problem.** The log is `%APPDATA%\Framelet\logs\main.log`; it contains diagnostic text only (no capture content) and the Windows user-name part of paths is replaced by `~`. Read it before attaching it anywhere.
