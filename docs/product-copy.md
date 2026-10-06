# Product copy (draft)

Local draft text for a future website or store page. Not published. Name is provisional (FrameCapt). Only claims backed by [capability-matrix.md](capability-matrix.md) are used; do not add claims without verifying them. A final tagline is an owner task. The app has no account and makes no network requests of its own.

## One-line description

FrameCapt is a screenshot and screen recorder for Windows: capture, mark up and redact, and keep everything on your own computer. Your captures are never uploaded.

## Short description (about 50 words)

FrameCapt captures screenshots and screen recordings on Windows with a shortcut, lets you annotate and permanently redact sensitive areas, and saves everything on your own computer. There is no account or sign-in; your captures are never uploaded, and there is no telemetry. Free and open source (GPL-3.0); the official build is intended to add a signed installer (once the owner has a certificate), updates and support.

## Long description

Bug reports, support tickets, tutorials and client feedback all start the same way: press a shortcut, grab what is on screen, add a note, send it. FrameCapt does exactly that and nothing you did not ask for.

Take a screenshot of a screen, a window or a region, then mark it up with arrows, rectangles and text. When something private is in the picture, cover it with the Redact tool: redactions are solid black and are baked into the saved image, the clipboard copy and the history thumbnail, so they cannot be undone by whoever receives the file.

Record your screen, a window or a region at 1080p or full resolution, with your microphone, your system audio or both mixed into one track. A small floating toolbar shows the timer and lets you pause or stop; it is excluded from the recording. Recordings are written to disk while you work, so a long session does not eat your memory, and if the app is interrupted, the next start offers to recover what was saved (best effort). Convert recordings to MP4 when you need to share them.

Your captures are yours. They are never uploaded, and FrameCapt sends no telemetry. There is no account and no sign-in. History is a local list of your files; removing an entry never deletes a file, and deleting a file goes to the Recycle Bin.

FrameCapt is free software under the GNU GPL v3. You can read, build and change the source. Buying the official build supports development and is intended to give you a signed installer (once signing is in place), a year of updates and email support (availability depends on the owner finishing signing and checkout).

## Feature bullets

- Screenshots of screen, window or region, PNG or JPEG, or straight to the clipboard
- Editor with crop, arrows, rectangles, text and undo/redo
- Solid, flattened redaction (no hidden layers)
- Screen, window and region recording, 1080p or source resolution, 30 or 60 fps
- Microphone and system audio, separately selectable, mixed into one track
- Pause, resume, countdown and a floating toolbar excluded from the recording
- Disk-backed recording with best-effort recovery after a crash
- MP4 export with progress and cancel
- Local history with search; delete goes to the Recycle Bin
- Configurable global shortcuts, tray icon, light and dark themes, keyboard-accessible
- Captures stay on your computer: no uploads, no cloud storage, no telemetry
- No account, no sign-in
- Open source (GPL-3.0-only)

## Facts you may quote (with their limits)

- Measured on one Windows 11 PC (Ryzen 7 7700): a 30-minute 1080p30 recording averaged 29.72 fps with +10 ms audio/video drift.
- No network traffic in 60-second runs of the test build and installed app, including a recording and an export.
- Windows 10 and later, x64. (Windows 11 only has been tested.)
- The installer is about 229 MB because it includes FFmpeg.

## FAQ

**Is FrameCapt free?** The software is free and open source (GPL-3.0). You can download the source, build it and use it at no cost. The official signed build with a year of updates and support is a paid, optional purchase (proposal: US$15). Nothing is unlocked by paying: there are no license keys and no locked features.

**Why pay for GPL software?** Because free software is about freedom, not price: the GPL lets people sell copies and charge for services, and it lets you do whatever you like with the source too. If you buy the official build you pay for the convenience, a signed installer, updates for a set period and support, and you help the project continue. If you would rather build it yourself or use a free copy, you may. The GNU project explains selling free software here: https://www.gnu.org/philosophy/selling.html.

**What happens after the 12 months of updates?** Your installed version keeps working, with no expiry and no license check. You just stop getting official updates and support unless you renew or buy a later major version.

**Can I share or modify what I bought?** Yes. You have all GPL rights: use, study, modify and redistribute (under the GPL, with source).

**Does it upload my screenshots or recordings?** No. There is no cloud storage, upload or sharing link. Files stay in your Pictures and Videos folders and FrameCapt's data folder.

**Do I need an account?** No. There is no account and no sign-in; the app works fully offline.

**Can people see my redacted content?** Redactions are solid black pixels in the saved file, the clipboard image and the thumbnail. The unredacted original exists only inside FrameCapt's data folder while the editor is open.

**Does it record system audio and my microphone?** Both, separately switchable, mixed into one track. System audio is whatever Windows plays on the default output.

**Why is a window black?** Windows blocks capture of DRM-protected video (for example some streaming sites). That is a Windows limit.

**Why does Windows warn me when I run the installer?** The current builds are not code-signed, so SmartScreen warns. The official paid build is intended to be signed once the owner has a certificate.

**Is the recovery lossless?** No. It is best effort; expect to lose up to about a second at the end.

**Which Windows versions?** Windows 10 and 11, 64-bit. Tested on Windows 11 only. No macOS version; an experimental Linux build exists.

**Does it support MP4?** Yes: recordings are saved as WebM and can be converted to MP4 (H.264 + AAC).

**Which license applies to FFmpeg inside?** The bundled FFmpeg is a GPL build; its source and notices are provided with releases. See THIRD_PARTY_NOTICES.md.
