# Changelog

All notable changes to FrameCapt are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The name FrameCapt is provisional.

## [Unreleased]

- **Meeting capture.** FrameCapt notices Google Meet, Zoom, Microsoft Teams and Webex calls and offers a small card (Record meeting, Meeting + my screen, Add to current recording, Not now, Don't ask for the app). When the meeting window is minimized, hidden or gone, its place in the video shows a neutral card and the audio keeps recording. A screen you share in the call can be added automatically or on request. Settings > Meetings. English window titles only; Chrome tab sharing is not detected; Teams needs microphone activity. See docs/decisions.md ADR-053.
- **Live panels.** While a screen, window or region recording runs, add up to three more regions, windows or screens to the same video, and hide or remove them without stopping. See ADR-051.
- **Several recordings at once.** Up to three recordings run at the same time, each with its own toolbar and file; system audio and the camera belong to the first one. Stop all from the main window. See ADR-051.
- **Screenshots during a recording.** A toolbar screenshot menu takes any kind of screenshot while recording; it is saved straight to the Library.
- **Win32 window and microphone probe (koffi).** Richer window facts for meeting detection, with a fallback where koffi cannot load. See ADR-052.

- **Captures go to the clipboard automatically.** Every screenshot is copied (as a PNG) when it is captured (also while recording and for All screens) and again, with redactions applied, when you save an edit (Settings > Screenshots > "Copy every screenshot to the clipboard", on by default). Every saved recording, exported video and step guide is copied as a file you can paste into Explorer, chat or email (Settings > Recording, on by default); after a conversion the new file replaces the old one on the clipboard. This replaces "Copy to the clipboard when saving" and the "Copy to the clipboard, then open the editor" choice (an old settings file keeps the same behaviour). See docs/decisions.md ADR-049.
- **Recording save format and compression.** Settings > Recording > **Save recordings as** (WebM, MP4, MKV, GIF) and **Compression** (Off, Light, Balanced, Strong) replace "Video storage" (Compressed becomes MP4 + Balanced). MKV is a lossless re-wrap; GIF is for clips up to 60 seconds; the original goes to the Recycle Bin only after the new file is verified. History gets **Save in another format...** (format, compression, optional width) that makes a new item and never replaces the original. MKV is now a History format.
- **Fixed:** the fullscreen button of the video player in the Library was denied ("Denied permission request: fullscreen"). Fullscreen is now allowed for the main window only.

- **Folders in the Library.** A folder pane (All captures, a tree with counts, Other locations) organizes captures in **real folders on disk**, mirrored in the screenshots and recordings folders. New folder, New subfolder, inline Rename (`F2`), Move contents to parent, Delete (empty folders only, never your captures), Show in Explorer, Set as save location. Drag cards (or a selection) onto a folder, or use **Move to...** (card menu, right-click menu, selection bar); the files move on disk, and History, editable screenshots and step guides keep working. New screenshots, recordings and step guides can be saved into a chosen folder (the Capture view shows "Saving to: ..."). "Find existing captures" now looks inside folders, so a reinstall restores the organization. A plain card drag now moves it to a folder; Alt+drag still drags the file out to other apps. See docs/decisions.md ADR-048.

- **A new layout: icon rail, tabs and a Library.** The labeled sidebar is now a slim **icon rail** (Home, Library, Guides, Settings; Keyboard shortcuts at the bottom; tooltips, arrow keys, a red dot on Home while recording). Editing no longer happens in a window of its own: the **Editor window is gone** and every screenshot, video (including multi-source) and step guide opens as a **tab** beside the pinned **Home** tab, which cannot be closed. Opening something that is open shows its tab; each tab keeps its undo history, zoom and playhead; tabs close with ×, a middle click or `Ctrl+W` (never Home), switch with `Ctrl+Tab`, `Ctrl+Shift+Tab` and `Alt+1` to `Alt+9`, scroll with a fade and arrows when there are many and drag to reorder. A dot marks unsaved work; closing a tab asks **Save / Don't save / Cancel**; quitting asks once. **Home** is a capture dashboard: Screenshot and Record tiles (Region, Screen, Window, All screens, Multiple...), Steps, Open image, a compact options bar and your latest captures. **History is now the Library**, built like a file manager: a flush sidebar (All captures, Recent, Screenshots, Recordings, Guides with counts; your real folders as a tree with counts and a pin on the save location; resizable, `Ctrl+B` hides it), a breadcrumb, search, sort, a grid or a table view, and a menu with Include subfolders and Find existing captures. "Captures stay on this device." moved to Settings > About. See docs/decisions.md ADR-050 (it replaces ADR-047).

- **Video editor: text, pictures, audio clips and frame rate.** Add **text** (up to 500 characters; font, size, weight, italic, colour, alignment, shadow, outline, a background with padding, corners and opacity; start, end and fades), **pictures or logos** (from a file or from History, with opacity and fades) and **audio clips** on an audio track (MP3, WAV, M4A, AAC, OGG, Opus, FLAC; move, trim inside the file, volume, mute, fades; they mix with the recording's sound and follow your cuts). Text is drawn by the same code for the preview and the export, so the result looks like the preview. Pictures and audio are kept with the project (named by their SHA-256). A 60 fps recording is now exported at 60 fps (the recorder remembers the rate; older files use the rate they report when believable). The export menu shows the length, picture size and a rough file size, and **Show in folder** appears when it is done. Fixed: a mouse click on a toolbar button of the video editor left it holding the keyboard, so `Space` pressed it again. See docs/decisions.md ADR-044.

- **Video editor (core).** History > a WebM or MP4 recording > **Edit video** (also on the card, the context menu and the command center): a preview with a drawing layer, a zoomable timeline (trim handles, hatched cut pieces, range selection, item rows with snapping), and an inspector. Trim, cut pieces out, hide areas for a chosen time (solid box in a colour, blur, pixelate, spotlight), crop (Free, 16:9, 9:16, 1:1, 4:3), mute or change the volume (0 to 200 %), fade in and out, undo and redo, automatic saving of the project, keyboard shortcuts (`Space`, arrows, `I`/`O`, `Delete`, `Ctrl+Z`, `Ctrl+S`). **Export** MP4, WebM or GIF (size and GIF frame rate options) with progress and Cancel; the result is a new file `<name> (edited).<ext>` next to the recording and a new History item; the recording is never changed. Rendered by one ffmpeg filter graph that is verified (format, size, length) before it is kept; a redaction is flattened into the exported pixels. GIFs are now a History format (shown as an image). See docs/decisions.md ADR-043. Text, images and audio clips follow in a later phase.
- The "full timeline" deferral in the project contract is lifted (owner decision, 2026-10-06).

- **Step guides.** A new capture option, **Steps** (Capture view card, File menu, command center, tray, `Ctrl+Shift+8`; "Capture a step" has no default key): move the mouse to an item and pause, and FrameCapt takes a screenshot with the pointer highlighted. A small pill (Auto, Capture step, Pause, Done, Cancel) replaces the window while you work. Done saves a `FrameCapt Steps ...` folder (`step-NN.png`, `flow.json`) and a **Guide** in History, which opens in the **Flow view**: editable title and captions, reorder, delete with Undo, open a step in the editor, and export as numbered PNGs, a self-contained HTML page, an MP4 slideshow or a GIF. No global input hooks are used (ADR-045).

- **Open pictures and image layers.** File > Open image (`Ctrl+O`, the Capture view, the command center), dropping a picture on the window or pasting one on the Capture view opens it in the editor (PNG, JPEG, WebP, GIF, BMP; nothing is saved until you save). Inside the editor, **Insert image** places a picture as a layer (from a file, from History, by paste or by dropping it on the canvas): move, resize (proportions kept, Shift frees them), corner radius, opacity, drop shadow, Reset size. Layers are flattened into the export and kept with the editable project (document schema 3; older projects open unchanged); redactions still cover everything.

- CI now only builds Windows installer/ZIP and Linux .deb/AppImage artifacts. Automated test and smoke jobs are removed from CI; local validation commands remain available.
- **Desktop only, no accounts.** The repository is now the Electron desktop app only. There is no backend API, no website, no sign-in, no account menu, no lock screen, no organizations or workspaces, no offline grants and no OIDC; the app works as the alpha.3 builds did (no sign-in) and keeps the later desktop features (custom title bar, command center and palette, professional editor, multi-select and bulk actions in History, customizable shortcuts). The account, organization, website and API work is preserved on the branch `login-website`.
- **Privacy statement.** Captures are never uploaded and there is no telemetry or account service; the app makes no network requests of its own.
- Existing local history files still load; ownership fields written by account builds are ignored.

## [0.1.0-alpha.3] - 2026-10-03

Privacy fix release ([release notes](docs/release-notes-0.1.0-alpha.3.md)).

- **Fixed (privacy):** Chromium's built-in spellchecker could download its English dictionary from Google (`redirector.gvt1.com`) on Linux, although FrameCapt never checks spelling. The spellchecker is now switched off completely on every platform (`--disable-spell-checking`, no languages), enforced by a unit test. Affected: the Linux packages of 0.1.0-alpha.2. No connection was measured on Windows.
- Tests and CI: GitHub Actions now runs the full suite on Windows and Linux (E2E, Linux package install smoke test); recorder start/stop races covered by new regression tests (no product bug found).

## [0.1.0-alpha.2] - 2026-10-03

Second alpha pre-release: adds Linux packages ([release notes](docs/release-notes-0.1.0-alpha.2.md)).

- Experimental Linux x64 build (.deb, AppImage): X11/XWayland, microphone only (no system audio), launch at login through an XDG autostart entry, pinned Linux FFmpeg 9.0.2 and AppImage runtime. Built and tested in WSL2 and on Xvfb only; unsigned. See docs/building-on-linux.md.

## [0.1.0-alpha.1] - 2026-10-03

First alpha pre-release, published on GitHub with an unsigned Windows installer and portable zip ([release notes](docs/release-notes-0.1.0-alpha.1.md)). Contains everything listed under 0.1.0 below plus:

- Renamed from the working name Framelet to FrameCapt (2026-10-03). The name is still provisional; trademark clearance is pending. Nothing was released under the old name, so no user-data migration is needed: the user data folder follows the product name (`%APPDATA%\FrameCapt`).

- New FrameCapt logo (owner artwork) across the app: application and installer icon, tray icons with a recording marker, sidebar and About. Added a start-up screen for the main window (brand loader, respects reduced motion), a reusable brand loader for finishing a recording, starting an MP4 export, recovery and the window picker, and an installer loading animation (Squirrel `loadingGif`). Brand assets are generated by `npm run brand:assets`; the name and logo are not covered by the GPL (see docs/licensing.md).

### 0.1.0 (beta, not yet released)

#### Added

- Screenshots of a screen, a window or a rectangular region (one monitor per region), with pixel-exact full-resolution capture of screens, saved as PNG or JPEG or copied to the clipboard.
- Screenshot editor: crop, arrow, rectangle, text, solid opaque redaction flattened into exported pixels, clipboard image and history thumbnail, 200-step undo/redo, zoom and keyboard shortcuts.
- Screen, window and region video recording (VP9 + Opus WebM) at 1080p or source resolution, 30 or 60 fps, with optional microphone and Windows system audio mixed into one track, pause/resume/stop, floating toolbar with timer and optional 3-2-1 countdown.
- Disk-backed recording sessions (sequenced, acknowledged, bounded chunks; manifest), FFmpeg remux into a seekable WebM, disk-space checks, and best-effort recovery of unfinished recordings at the next start.
- MP4 export (H.264 + AAC) with progress and cancel, using a bundled FFmpeg 9.0.2 (Gyan "essentials" build, GPL-3.0-or-later).
- Local capture history with search, thumbnails from flattened output, missing-file handling, and delete-to-Recycle-Bin.
- Settings, configurable global shortcuts with conflict detection, tray icon, close-to-tray, launch-at-login option, light/dark theme following Windows, keyboard-accessible UI.
- Windows installer (Squirrel, per-user, **unsigned**) and portable zip; production UI served from the local `app://framecapt` scheme; update adapter present but disabled until an update source exists.
- No telemetry, no uploads, no network requests of its own (measured).
- Open-source documentation: README, user guide, build guide, contributing guide, code of conduct, security policy, privacy statement, third-party notices, GPL-3.0-only license.

#### Known limitations

- The installer and executables are not code-signed; Windows SmartScreen will warn.
- Tested on Windows 11 x64 only; Windows 10, ARM, mixed-DPI/rotated monitors and screen readers were not tested on real hardware.
- Crash recovery is best effort (expect to lose up to about a second of media; power-loss behavior was not tested).
- No automatic updates; no macOS or Linux builds.
- H.264/AAC/VP9/Opus patent and licensing review is an open owner task; FFmpeg source distribution for binary releases is an open owner task.
