# FrameCapt user guide

FrameCapt (provisional name, beta 0.1.0) captures screenshots and screen recordings on Windows and keeps every capture on your computer. There is no account or sign-in. This guide describes what the current build does. For the list of default shortcuts see [keyboard-shortcuts.md](keyboard-shortcuts.md).

Contents: [The top bar](#the-top-bar-menus-and-command-center) - [Screenshots](#screenshots) - [The editor](#the-editor) - [Redaction](#redaction) - [Recording](#recording) - [Unfinished recordings](#unfinished-recordings) - [Export to MP4](#export-to-mp4) - [History](#history) - [Settings](#settings) - [Tray](#tray) - [Troubleshooting](#troubleshooting)

## The top bar: menus and command center

The top of the window is one bar, like a code editor's: the FrameCapt logo and the menus **File**, **View** and **Help** on the left, a wide search box (the command center) in the middle and, on Windows and Linux, the window buttons (minimize, maximize, close) at the far right. Drag the empty part of the bar to move the window; double-click it to maximize or restore. In a narrow window the three menus fold into one **Menu** button and the search box shrinks to a magnifier.

- **File**: New screenshot and New recording (region, window or screen), History, Settings and **Quit FrameCapt** (asks first while a recording runs). **View**: Capture, History, Settings, the command center and **Toggle light or dark theme**. **Help**: Keyboard shortcuts and About FrameCapt (Settings, About). Each item shows its current shortcut. An item that cannot run right now (a recording is in progress) stays in the menu, greyed out; hover it to read why.
- **Command center**: click the search box, or press `Ctrl+K` (`Ctrl+Shift+P` for commands only). Type a few letters of what you want: "region", "record", "history", "shortcuts", or the name of a saved capture. Commands come first, grouped (Capture, Navigate, Help); saved captures follow under **Recent captures** (the name is matched; a few are shown). `Enter` runs the highlighted result: a command does exactly what its button does (for example **Take screenshot – region** starts the same region selection as the Screenshot > Region button), a capture opens in History. `Shift+Enter` on a capture shows it in its folder. With nothing typed, the commands you used last are listed first. Unavailable commands are listed with the reason. Both keys can be changed in Settings, Shortcuts.

## First run

There is no account and nothing to sign in to: the app opens ready to capture. The Capture screen shows a **Welcome** card: that everything stays on your device, your global shortcuts as they are set now, and that closing the window keeps FrameCapt in the tray. **Got it** dismisses it for good (it is remembered in the settings; it also dismisses the one-line shortcut tip).

## Screenshots

Start from the home screen (**Capture > Screenshot**) or from a global shortcut:

- **Screen** (`Ctrl+Shift+1`): with one display the capture happens at once. With several displays, a translucent overlay appears on each; click the display you want (or press `Enter`). The image is the display's full physical resolution.
- **Window** (`Ctrl+Shift+2`): a picker lists the open windows (search or arrow keys). The window's visible frame and title bar are included; minimized windows are not listed.
- **Region** (`Ctrl+Shift+3`): the screen freezes under an overlay; drag a rectangle, move it, resize it with the handles, or use the keyboard (arrow keys start a centered selection, `Shift` moves 10 px, `Alt` resizes, `Enter` captures, `Esc` or right click cancels). A region stays on **one** monitor.
- **All screens** (`Ctrl+Shift+4`, shown when more than one display is connected): one image of every screen, each at its place on your desktop (gaps between screens are transparent). It must fit in 16384 px on each side, otherwise FrameCapt says so and you can capture the screens one at a time.

After a capture the screenshot opens in the editor (Settings > Screenshots > "After a capture" can also copy it to the clipboard or save it first). The selection overlay, pill and dim layer are never part of the image.

Save with `Ctrl+S` (PNG or JPEG, your choice in Settings; you pick the file name in a save dialog). **Quick save** (`Ctrl+Shift+S`, or the entry in the Save menu) skips the dialog: the screenshot goes straight into your screenshots folder (Settings > Storage) under the usual name ("FrameCapt 2026-10-02 at 14.05.09.png"; a name that is taken gets "(2)"), and a message offers **Show in folder** and **Undo** (which moves the new file to the Recycle Bin). The key can be changed in Settings > Shortcuts or copy with `Ctrl+C` (image to the clipboard). Saved screenshots go to `Pictures\FrameCapt` unless you changed the folder.

## The editor

Tools are grouped in the toolbar (hover one for its key; every key can be changed in Settings, Shortcuts):

| Group    | Tool        | Key | What it does                                                                                                |
| -------- | ----------- | --- | ----------------------------------------------------------------------------------------------------------- |
| Pointer  | Select      | `V` | Select, move and resize marks; `Shift`-click or drag a box to select several; `Delete` removes them         |
| Pointer  | Crop        | `C` | Drag to crop (non-destructive until you save); Free, 16:9, 4:3 and 1:1 shapes                               |
| Shapes   | Rectangle   | `R` | Outline, fill, fill opacity, corner radius, optional drop shadow                                            |
| Shapes   | Ellipse     | `O` | Same as the rectangle (`Shift` for a circle)                                                                |
| Shapes   | Line        | `L` | Solid, dashed or dotted                                                                                     |
| Shapes   | Arrow       | `A` | Straight or curved (drag the round handle to bend it), a head or a dot at either end                        |
| Shapes   | Pen         | `P` | Freehand, smoothed                                                                                          |
| Annotate | Text        | `T` | Font (sans, serif, mono, handwriting), size, weight, italic, alignment, background and outline              |
| Annotate | Callout     | `D` | A speech bubble with text; drag its round handle to aim the tail                                            |
| Annotate | Step number | `N` | Numbered badges, counting up; **Reset** restarts at 1                                                       |
| Annotate | Stamp       | `E` | Check, cross, star, heart, warning, question, info (drawn as shapes: no fonts or downloads needed)          |
| Effects  | Highlighter | `H` | A translucent marker, as a box or freehand                                                                  |
| Effects  | Blur        | `B` | Blur or pixelate an area, with an intensity slider. **A visual effect, not secure**: use Redact for secrets |
| Effects  | Redact      | `X` | Drag to cover an area with solid black                                                                      |
| Effects  | Spotlight   | `S` | Dim everything outside an area                                                                              |
| Effects  | Magnifier   | `M` | A circle that enlarges what is under it                                                                     |
| Effects  | Ruler       | `I` | Measure a distance in pixels                                                                                |

**Opening a picture.** To edit a picture that is not a capture, use **File > Open image** (`Ctrl+O`), the **Open image** button on the Capture view, or the command center; you can also drop an image file on the window or paste one (`Ctrl+V`) on the Capture view. PNG, JPEG, WebP, GIF (first frame) and BMP open as an ordinary editor session; nothing is saved until you save, and the "after a capture" setting does not apply.

**Image layers.** **Insert image** (the picture button after the tools, `Ctrl+Shift+O` for From file) adds a picture on top of the screenshot: From file, From History, paste with `Ctrl+V` while the editor is focused, or drop an image file on the canvas (it lands under the pointer). A new picture is centered and scaled to fit within 60 % of the canvas, then selected: drag to move, drag a handle to resize (proportions are kept; hold `Shift` to stretch freely). The Properties panel has corner radius, opacity, drop shadow and **Reset size** (back to the picture's own pixels). Image layers are part of the export and the thumbnail and are kept with the editable project (up to 32 pictures, 64 MB in total); redactions are always drawn above them.

The **Properties** panel (toggle it with the panel button in the toolbar) has the exact numbers for the selected mark, or for the active tool when nothing is selected: color (the palette, a hex code, recent colors and, where the system allows it, an eyedropper), stroke width, opacity, fill, corner radius, drop shadow, text, arrow and effect settings. Under **Arrange** you can bring marks forward or back (`Ctrl+]` / `Ctrl+[`), duplicate them (`Ctrl+D`), align them to each other (or to the image when one is selected), distribute three or more evenly, and turn the snapping guides on or off. **Canvas** has the crop shape, **Beautify** (a background color or gradient, padding, rounded corners and a shadow around the exported image; the crop stays non-destructive) and **Preview the result**, which shows exactly what Save will write.

Other keys: `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo (200 steps, covering every edit above), `Ctrl+=` / `Ctrl+-` zoom, `Ctrl+0` fit, `Ctrl+1` 100%, arrow keys move the selected mark. Closing the editor with unsaved changes asks first. While the editor is open the unedited original is in FrameCapt's app-data folder; the session copy is deleted when the editor closes (unfinished leftovers older than 7 days are swept). After you save, an editable copy is kept with the history item unless you turned **Keep editable originals** off (see [Editing a saved screenshot](#editing-a-saved-screenshot)).

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
- **Follow mouse** (Off, 1.5×, 2×, 3×; screen recordings only): the video becomes a zoomed window that glides smoothly to wherever the mouse is, so what you point at stays in view. At 2× on a 3440 × 1440 screen the video shows a 1720 × 720 window. Small mouse movements near the middle of the window do not pan it. Window and region recordings ignore this option.
- **Also save an MP4**: converts every finished recording to MP4 next to the original (off by default).
- **Video storage**: **Original** (the default) keeps the recording as saved, best quality and larger files. **Compressed** records at a lower bitrate and, after you stop, re-encodes the recording to a smaller MP4 (H.264 + AAC, see [Compressed storage](#compressed-storage)). It replaces **Also save an MP4**: you get one MP4, not two.

While recording, a small floating **toolbar** shows the timer and status with Pause/Resume, a **camera button (Take screenshot)**, Mute buttons and Stop. A screenshot taken while recording (the camera button, or the screen, region and all-screens shortcuts) is saved straight to your screenshots folder and listed in History; no editor opens, a short "Screenshot saved" appears in the toolbar, and FrameCapt's window is never brought up, so it cannot end up in the video. The toolbar button captures what is being recorded (the whole screen, the recorded region or the recorded window). Window screenshots from the shortcuts are not available while recording. **Hide controls** (the arrows at its end) tucks it into a small indicator with the timer and a button to bring the controls back; recording is not affected and `Ctrl+Shift+9` / `Ctrl+Shift+0` still pause and stop. The toolbar and the countdown are excluded from the recording (verified on the test machine through Windows' content-protection setting; this exclusion is a platform behavior, so do not rely on it for anything security-critical). Paused time is not recorded. Stop with the toolbar, the main window, the tray menu, or `Ctrl+Shift+0` (pressing the record shortcut again also stops).

Recordings are written to disk **while** you record (bounded memory, a 30-minute 1080p30 recording was benchmarked: [performance.md](performance.md)) and finished into a seekable `.webm` (VP9 video, Opus audio) in `Videos\FrameCapt`, named `FrameCapt YYYY-MM-DD at HH.mm.ss.webm`. Existing files are never overwritten.

If the disk gets low, FrameCapt refuses to start below 1 GB free and stops safely (keeping what was recorded) below 500 MB free. If a source disappears (a window closes, a device is lost) the recording stops and what was captured is saved.

Quitting while recording asks first; if you quit, FrameCapt stops and finishes the recording (up to 15 seconds; otherwise it finishes at the next start).

### Recording several screens or windows together

On **Capture > Record**, **All screens** (shown when you have two or more screens) records every screen into one video, and **Multiple...** opens a picker with your screens **and** open windows: tick 2 to 4 of them (click, or `Space` on a focused card). The numbers on the cards show the order; the first one is the main source (it also carries the system audio). **Record N sources** starts the recording. The command center (`Ctrl+K`) has the same two entries ("Record - all screens", "Record - multiple sources...").

- Screens only keep their places side by side, as they sit on your desk. As soon as a window is among the sources, they are laid out in a grid. The whole picture is capped at 3840 × 2160 (and about 4 million pixels) with the 1080p quality, and about 8 million pixels with Source quality, so each source may be smaller than on screen.
- If one source goes away (a screen is unplugged, a window is closed) its place shows "Source ended", the toolbar shows a warning and the recording goes on with the others. When every source is gone the recording is saved.
- Follow mouse does not apply. The camera button on the toolbar takes a screenshot of the main (first) source.

The result is saved as `FrameCapt YYYY-MM-DD at HH.mm.ss.fcap` in `Videos\FrameCapt`. **A `.fcap` file plays only in FrameCapt**: other players cannot open it, and there is no "Open" in another program. In History the card carries a **Multi** badge with the number of sources, and its details view plays it with tabs (**All**, **Screen 1**, **Window 2** ...) that show the whole picture or one source. **Extract...** saves one source (or all of it), between a start and an end time you choose with the time fields or the sliders, as an ordinary **MP4** or **WebM** video next to the original (`... - Screen 1.mp4`); it appears in History as a new item, with progress and **Cancel** like an MP4 export. The `.fcap` itself is never changed. An interrupted multi-source recording is recovered into a `.fcap` too. **Export MP4** and **Compressed storage** do not apply to a `.fcap` (extract an MP4 instead).

### Camera

Turn on **Camera** in the recording options (or Settings > Recording), pick a camera if you have several, and choose a **circle** or **rounded** shape and a **size** (S, M, L). When the recording starts, a small bubble with your camera appears on the screen. **Drag it anywhere** you want the camera to be in the video; hover it for buttons to change its size and shape or to hide it. The camera is recorded into the video itself, so it shows exactly where the bubble sits.

- Screen and region recordings: the camera sits where you leave the bubble inside the recorded area (it stays inside it). It starts at the bottom right.
- Window recordings: the camera takes the corner of the video that the bubble is closest to; drop the bubble near a corner and it snaps there.
- The toolbar has a **camera button (Hide camera / Show camera)**. Hiding the camera takes it out of the video until you show it again.
- The bubble is not captured by the recording (the camera is added by FrameCapt, not seen through the screen). Like the toolbar, this relies on a Windows setting.
- If the camera cannot be opened (not connected, used by another app, or blocked in Windows Settings > Privacy & security > Camera) FrameCapt asks: record without the camera, or cancel.
- If a camera you saved is no longer connected, the default camera is used. If your camera is unplugged while recording, the overlay disappears and the recording goes on.

## Unfinished recordings

If FrameCapt or Windows ends abruptly during a recording (crash, forced kill, power loss), the next start shows a card: "We found an unfinished recording" with **Recover** and **Discard**. Recovery is **best effort, not lossless**:

- In forced-process-kill tests, the recovered file lacked up to about 0.7 s at the end (the unsent second of media plus the in-flight chunk); that was three runs on one machine, not a guarantee.
- After a power cut or Windows crash, data still in the OS write cache may be missing; this was not tested.
- If the very start of the file (its header) is missing, the recording cannot be repaired; FrameCapt says so and keeps the raw data for diagnostics.

"Discard" deletes only that unfinished session after you confirm. Details: [recording-persistence.md](recording-persistence.md).

## Export to MP4

Recordings are saved as WebM. For a recording in History (or on the result screen) choose **Export MP4**: pick a destination, watch the progress, and cancel if you like. The conversion is real (H.264 video and AAC audio, with the index at the start of the file); a file is never just renamed. A cancelled or failed export leaves your original untouched and no partial file behind. If the bundled FFmpeg cannot do H.264/AAC, the app says MP4 export is unavailable and the WebM remains your file. One export runs at a time.

### Compressed storage

With **Settings > Recording > Video storage: Compressed**, a saved recording is re-encoded in the background to a smaller MP4 (H.264, CRF 28, AAC 96 kbps, index at the start). Its History card shows "Compressing..." with progress and a Cancel button. Only when the new file has been checked (H.264 video, audio kept, same length within half a second) does the History entry switch to the MP4 (same entry, thumbnail and date) and the original WebM move to the **Recycle Bin**, so it can be restored. If compression fails, is cancelled or the app is closed meanwhile, the WebM stays exactly as it was and nothing partial is left behind. The recorder also uses a lower bitrate (60 %) while this setting is on. Needs the same H.264/AAC-capable FFmpeg as Export MP4.

## Step guides

**Steps** (a card on the Capture view, **File > New step guide**, the command center, the tray, or `Ctrl+Shift+8`) records a step-by-step guide, like the Windows Steps Recorder. Press Start: FrameCapt's window gets out of the way and a small pill appears at the bottom of the screen (it is never in your screenshots). Move the mouse to an item and **pause there for a moment** (the pointer rests within a few pixels for about 0.7 seconds): FrameCapt takes a screenshot of that screen and remembers where the pointer was. Moving on and resting on the next item takes the next step; steps are never closer than 1.5 seconds. Resting on the pill itself is not a step.

The pill shows the number of steps and has: **Auto** (off: only manual steps), **Capture step** (the camera: a step right now; also the "Capture a step" shortcut, which has no default key: set one in Settings > Shortcuts), **Pause / Resume**, **Done** and **Cancel** (asks before it throws the steps away). At 200 steps the capture pauses itself and says so; press Done to keep what you have. A guide cannot be captured while a recording or a screenshot is in progress, and the other way round.

**Done** saves a folder `FrameCapt Steps YYYY-MM-DD at HH.MM.SS` in your screenshots folder with `step-01.png` ... and `flow.json`, adds it to History (kind **Guide**, "N steps") and opens it in the **Flow view**: an editable title, one card per step with the screenshot and the pointer ring (drawn on top, never burned into the saved PNG), a caption box (saved by itself), move up / down or drag to reorder, delete (with Undo), and **Open in the editor** (annotate or crop that step; **Save changes** writes over that step's picture). **Export** makes numbered PNGs with the ring and a caption banner, one self-contained **HTML page** (pictures inline, captions escaped, no scripts, no web addresses), or a **slideshow video (MP4)** or **animation (GIF)** with 2.5 seconds per step (the video or animation is also added to History). In History a guide opens in the Flow view; "Show in folder" shows its folder; "Delete file" moves the whole folder to the Recycle Bin, but only when it holds nothing but `flow.json` and step pictures.

## History

**History** lists screenshots and recordings you saved (the newest six also appear on the home screen). Filter All / Screenshots / Recordings, search by name, date or type, press `Enter` to open the details, where you can open the file, show it in its folder, copy the image or the path, export MP4, save a copy of a recording, or remove it. A multi-source `.fcap` recording opens in FrameCapt itself (a player with a tab per source and **Extract...**), see [Recording several screens or windows together](#recording-several-screens-or-windows-together).

- **Select several**: `Ctrl`-click or `Shift`-click cards (or tick the checkbox on a card, or press `Ctrl+A`). A bar shows how many are selected with **Save copies...** (one folder dialog; each file is copied under a free name, existing files are never overwritten; progress, **Cancel** and a per-item summary if anything was skipped), **Remove from history** (asks first, with Undo), **Select all** and **Clear selection** (`Esc`). Viewers can select but not save copies.
- **Right-click a card** (or `Shift+F10`) for Edit, Open, Show in folder, Copy, Save a copy, Remove, Delete editable data and Delete file. Entries that are not available stay listed, disabled, with the reason.
- **Drag a card out of the window** (into a chat, an email, Explorer) to drop the actual file there.
- **Remove from history** removes only the list entry (with a 5-second Undo). It never touches your file.
- **Delete file** is a separate, confirmed action that moves the file to the **Recycle Bin**.
- If a file was moved or deleted outside FrameCapt, the entry stays listed as "File moved or deleted" with **Locate...** to point it at the new place, **Remove**, or **Clear missing**.
- **Find existing captures** (History, or the empty History page) adds screenshots and recordings that are in your output folders but not in the list, for example after a reinstall. It only reads files named like FrameCapt's own (`FrameCapt 2026-10-02 at 14.05.09.png`), never moves or changes them, and says how many it added. On a fresh start FrameCapt does this once by itself.
- **Uninstalling** asks whether to remove your FrameCapt data (history, settings, editable projects) as well; the default and a timeout keep it. Your screenshots and recordings stay unless you tick **Also move my screenshots and recordings to the Recycle Bin**.
- History keeps at most 1000 entries (older entries drop off the list; their files are never touched). It stores metadata and thumbnails only.

## Folders

History has a **folder pane** on the left (hide it with the button next to **New folder**). The folders are **real folders on your disk**: a folder you make in FrameCapt is made inside both your screenshots folder (default `Pictures\FrameCapt`) and your recordings folder (default `Videos\FrameCapt`), so Explorer, backups and other tools see the same organization. **All captures** shows everything; click a folder to show what is in it (the **Include subfolders** box adds what is below it); **Other locations** lists captures saved outside the two folders, so you can drag them in.

- **New folder** makes a folder inside the selected one (or at the top). A name can have up to 80 characters, folders can be 8 levels deep, and a name cannot contain `< > : " / \ | ? *`, start with a dot, end with a dot or a space, or be a Windows device name such as `CON`.
- **Right-click a folder** (or press `Shift+F10`): New subfolder, **Rename** (`F2`, inline), **Move contents to parent**, **Delete (empty only)**, **Set as save location** / **Clear save location**, and **Show in Explorer** for the screenshots copy and the recordings copy. Delete refuses a folder that holds anything; it never deletes your captures.
- **Move captures**: drag a card (or a selection) onto a folder (drop on **All captures** to take them out of their folder), or use **Move to...** in the card menu, the right-click menu or the selection bar. The file moves on disk; its History entry, an editable screenshot and a step guide (which moves as its folder) keep working. A name that is taken gets ` (2)`. To drag a file out to another app, hold **Alt** while dragging.
- **Keyboard**: the arrow keys move in the tree (`Right` opens a folder, `Left` closes it or goes to the parent), `Enter` selects, `F2` renames, `Delete` deletes an empty folder.
- **Save location**: the folder that new screenshots, recordings and step guides are saved into is marked with a pin, and the Capture view says "Saving to: Clients / Acme" with a **Change** link. Without one, captures go to the main capture folders. Exports that are saved next to their source stay next to it.
- **After a reinstall**, **Find existing captures** also looks inside your folders, so the organization comes back.

## Editing a saved screenshot

In **History**, choose **Edit** on a screenshot to open it in the editor again. If FrameCapt kept the editable version (Settings, Screenshots, **Keep editable originals**, on by default), every annotation can be moved, restyled or deleted. Screenshots saved earlier, or whose editable data was deleted, open as a flattened copy: you can add new annotations, but the old ones cannot be changed.

- **Save** replaces the saved image (the previous version is not kept); **Save as copy** makes a new history item.
- Redactions are applied in the saved image. The editable original keeps the pixels underneath, in FrameCapt's own data folder. Use **Delete editable data** in the item's details, or turn **Keep editable originals** off, if you do not want that.

## Video editor

In **History**, choose **Edit video** on a WebM or MP4 recording (the button on its card, its context menu, or its details view; the command center also has **Edit the latest recording**). The editor never changes your recording: **Export** writes a new file next to it, named `<recording> (edited).mp4` (or `.webm`, `.gif`; a number is added if the name is taken), and adds it to History as derived from the original.

- **Preview.** The recording plays on top of a drawing layer that shows what will be in the result. Play and pause with `Space`, step a frame with the arrow keys (`Shift`: a second). Playback skips the pieces you cut out and stops at the end of the trim, so what you watch is what you export.
- **Trim.** Drag the two ends of the clip on the timeline (or focus a handle and use the arrow keys). Everything outside is left out.
- **Cut a piece out.** Drag on the clip to select a range (or press `I` and `O` at the playhead), then **Cut selection** or `Delete`. The piece shows hatched. Select it and press `Delete` (or **Restore this piece**) to bring it back. Cutting several pieces is fine; the video continues without a gap.
- **Hide something for a while.** Pick **Redact**, **Blur**, **Pixelate** or **Spotlight**, then drag on the video. The box starts at the playhead and lasts three seconds; drag it on the preview to move or resize it, drag its bar on the timeline to move it in time or change its length (its ends snap to the playhead and to other edges; hold `Alt` to turn snapping off), or type exact values in the panel on the right. Redact is a solid box (black by default; choose another colour), Blur and Pixelate have a strength, and Spotlight dims everything outside the box. Redactions are drawn into the exported pixels. In the preview, blur and pixelation are close approximations of the export.
- **Crop.** **Crop** shows handles on the preview; Free, 16:9, 9:16, 1:1 and 4:3 set the shape. Everything outside the crop is left out.
- **Sound and fades.** Mute, or set the volume from 0 to 200 %. Fade in and fade out apply to picture and sound at the start and end of the result. A recording without sound gets a silent track so every player accepts the file.
- **Timeline.** `Ctrl` + mouse wheel or the zoom slider zooms (the whole recording fits at the left end of the slider; **Fit** resets it), a plain mouse wheel scrolls sideways, and a click on the ruler (or a drag) moves the playhead. Long recordings work the same as short ones.
- **Export.** The **Export MP4** button has a menu for the format (MP4 with H.264 and AAC, WebM with VP9 and Opus, GIF), the largest width (original, 1920, 1280, 960, 640) and, for GIF, the frame rate. A GIF has no sound, is limited to 960 px wide unless you choose another size, and is much bigger than a video of the same length: keep it short. Progress and **Cancel** replace the button while it runs; cancelling or a failure leaves no partial file. The result is checked (format, picture size, length) before it is kept. If another export or compression is running, yours waits its turn. The menu starts with what you will get: the length, the picture size and a rough guess of the file size. When it is done, **Show in folder** appears next to the button (and in the notification).
- **Saving.** The project (trim, cuts, boxes, crop, sound, fades and export options) is saved by itself a moment after every change, in FrameCapt's data folder, and comes back when you open the recording again. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo as long as the editor is open. Removing the recording from History (after the undo window) or deleting its file also deletes its project.
- **Add text.** Pick **Text** and drag a box on the video, then type in the panel on the right (up to 500 characters, several lines; the text wraps inside its box). Choose the font (the app font Inter, Arial, Georgia, Courier New or Impact), size, weight, italic, colour, alignment, a shadow, an outline and a coloured background with padding, rounded corners and opacity. Give it a start, an end and a fade in and out like any other item. The preview and the export draw it with the very same code, so the exported text looks exactly like the preview: text that does not fit its box is cut off at the edge, so make the box bigger.
- **Add a picture or logo.** **Image** > **From a file...** (PNG, JPEG, WebP, GIF or BMP) or **From History...** puts it in the middle of the video for three seconds; move and resize it on the preview, set its opacity and fades. FrameCapt keeps a copy of the picture with the project, so moving or deleting your original does not matter.
- **Add sound.** **Audio** opens a file dialog (MP3, WAV, M4A, AAC, OGG, Opus or FLAC, up to 100 MB and two hours). The clip lands on the **audio track** at the playhead; drag it to move it, drag its ends to change where it starts and ends inside the file (the right end cannot go past the end of the file), and set its volume (0 to 200 %), mute and fades in the panel. Clips may overlap and they play together with the recording's own sound, which keeps its own volume and mute. A clip sits on the recording's timeline like every other item: cutting a piece out of the video cuts the same piece out of the clip. In the editor you hear the clips at up to 100 % (the browser cannot play louder); the export uses the real level.
- **Frame rate.** A recording is exported at the frame rate it was recorded at (30 or 60 fps; the recorder remembers it). For older recordings FrameCapt uses the rate the file reports when it is believable, otherwise 30 fps.
- Not in this version: editing a GIF, speed changes, transitions between cuts, waveforms on the audio track, and editing recordings that are missing or damaged.

## Settings

Sections: **General** (theme: follow Windows / light / dark; launch at login; close to tray; notifications), **Screenshots** (format, JPEG quality, what happens after a capture, copy on save), **Recording** (quality, frame rate, follow mouse, countdown, microphone and device, system audio, also save MP4, video storage), **Shortcuts** (change or turn off each global shortcut and the editor's own keys; filter the list; a combination another action already has offers **Swap**; combinations Windows keeps for itself are refused with the reason; **Reset all shortcuts** puts everything back; see [keyboard-shortcuts.md](keyboard-shortcuts.md)), **Storage** (screenshots and recordings folders, chosen with a folder dialog and checked for write access), **Advanced** (capture diagnostics for troubleshooting), **About** (version and update status; updates are "Not configured for this build"). The **search box** at the top filters every section by what its options say (try "folder", "microphone" or "shortcut"); clearing it returns to the sections. Each section can be reset. Settings are stored in `%APPDATA%\FrameCapt\settings.json`.

## Tray

FrameCapt keeps one tray icon (a red dot while recording) with a menu for the capture actions (Screenshot: Screen, Window, Region and, with several displays, All screens). While recording, the screenshot items still work except Window. By default, closing the main window keeps FrameCapt running in the tray so global shortcuts keep working (a one-time notification explains this); turn "Close to tray" off to quit on close. "Launch at login" (off by default) starts FrameCapt hidden in the tray, and only works in the installed app. Quit from the tray menu.

## Troubleshooting

- **Protected content is black.** Windows does not let apps capture DRM-protected video (for example streaming services in a browser); that area is black in screenshots and recordings. This is a Windows platform behavior.
- **A window is missing from the list.** Minimized windows are not offered by Windows' capture API. Restore the window and pick it again.
- **System audio is unavailable.** Recording requires Windows' loopback audio. If no audio track arrives, FrameCapt shows an error and does not start the recording; try again, check your default output device, or record without system audio. (Changing the default output device during a recording was not tested.)
- **The microphone is silent or lost.** Check Windows microphone privacy settings and the selected device. If the microphone (or system audio) ends while recording, the toolbar shows a "Microphone disconnected" / "System audio ended" badge. (Unplugging a microphone mid-recording was exercised in tests with injected events, not with real hardware.)
- **A shortcut does not work.** Another app may own that key combination. Settings > Shortcuts shows "used by another app"; pick a different one. `Ctrl+Shift+0` may collide with Windows input-language hotkeys on some systems.
- **Low disk space.** Free some space; recording will not start below 1 GB free on the drive that holds `%APPDATA%\FrameCapt`, and stops safely below 500 MB.
- **Windows SmartScreen warns on the installer.** The installer is not code-signed yet (see [packaging.md](packaging.md)). Only run it if you obtained it from a source you trust and its SHA-256 matches.
- **Where are my files?** Screenshots: `Pictures\FrameCapt` (or the folder you chose). Recordings and MP4 exports: `Videos\FrameCapt`. Settings, history, unfinished sessions and logs: `%APPDATA%\FrameCapt`. See [../PRIVACY.md](../PRIVACY.md).
- **Reporting a problem.** The log is `%APPDATA%\FrameCapt\logs\main.log`; it contains diagnostic text only (no capture content) and the Windows user-name part of paths is replaced by `~`. Read it before attaching it anywhere.
