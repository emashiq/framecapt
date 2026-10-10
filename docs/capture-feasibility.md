# Capture feasibility (phase 02)

Status: **verified on a real Windows host** with `npm run test:native` (11 of 11 checks passed in the final run). Everything below marked "measured" comes from that run or the earlier runs of the same suite on the same machine; nothing is estimated. Numbers from a single machine are indications, not guarantees (see "Limits of this evidence").

## Host

| Item      | Value                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| OS        | Windows 11 Pro, 10.0.26300 x64                                                                                      |
| CPU / RAM | AMD Ryzen 7 7700 (16 logical cores), 63.1 GiB                                                                       |
| Electron  | 44.5.1 (Chromium 152.0.7977.130)                                                                                    |
| Displays  | "Mi monitor" 3440x1440 at DIP (0,0), primary, scale 1; "Redmi 27 NQ" 2560x1440 at DIP (3440,0), scale 1, rotation 0 |
| Audio     | Default output device present; inputs: Brio 100 and Jabra Evolve 10 (plus default/communications aliases)           |
| Tooling   | ffmpeg/ffprobe on PATH, used only by the test to verify files. The app never calls them                             |

Evidence: `docs/evidence/phase02/` (JSON summaries are tracked; PNG/WebM are gitignored). The screenshots and videos show the real desktop of the person running the test (browser tabs, other apps): do not publish them.

## APIs used (Electron 44.5.1, checked against `node_modules/electron/electron.d.ts`)

Main process:

- `screen.getAllDisplays(): Display[]`, `screen.getPrimaryDisplay(): Display`. `Display.bounds` (DIP), `scaleFactor`, `rotation` (0/90/180/270), `id: number`, `label`.
- `desktopCapturer.getSources(options: SourcesOptions): Promise<DesktopCapturerSource[]>` with `SourcesOptions = { types: ('screen'|'window')[], thumbnailSize?: Size, fetchWindowIcons?: boolean }`. `DesktopCapturerSource = { id, name, display_id, thumbnail: NativeImage, appIcon: NativeImage }`. Screen ids look like `screen:0:0`, window ids like `window:<hwnd>:0`; `display_id` equals `String(display.id)` on this host.
- `BrowserWindow.getMediaSourceId(): string` (format `window:<hwnd>:<n>`). FrameCapt's own windows are excluded from window sources by comparing the handle part.
- `session.setDisplayMediaRequestHandler(handler: ((request: DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Streams) => void) => void) | null, opts?: { useSystemPicker: boolean }): void`
  - `request = { frame: WebFrameMain | null, securityOrigin, videoRequested, audioRequested, userGesture }`.
  - `Streams = { video?: Video | WebFrameMain, audio?: 'loopback' | 'loopbackWithMute' | WebFrameMain, enableLocalEcho?: boolean }`, `Video = { id, name }`.
  - Grant: `callback({ video: { id, name }, audio: 'loopback' })`. Deny: `callback({})`.
  - `WebContents.fromFrame(frame)` maps the requesting frame to its webContents.
- `session.setPermissionRequestHandler` / `setPermissionCheckHandler`: for `media`, the request details carry `mediaTypes?: ('video'|'audio')[]` and the check details carry `mediaType?: 'video'|'audio'|'unknown'`.
- `shell.showItemInFolder(fullPath: string): void` for "Reveal diagnostics folder".

Renderer (Chromium 152): `navigator.mediaDevices.getDisplayMedia`, `getUserMedia`, `ImageCapture.grabFrame`, `MediaStreamTrackProcessor`, `MediaStreamTrackGenerator`, `VideoFrame` with `visibleRect`, `HTMLVideoElement.requestVideoFrameCallback`, `OffscreenCanvas.convertToBlob`, `HTMLCanvasElement.captureStream`, `AudioContext.createMediaStreamSource/createMediaStreamDestination`, `MediaRecorder`. All of these were present (`environment.json`).

## Authorization and denial (measured)

- Flow: renderer calls `capture:grant {sourceId, systemAudio}`; main validates the id against a fresh `desktopCapturer` listing and stores `{grantId, sourceId, systemAudio, webContentsId, expiresAt = now + 5 s}`; the display-media handler consumes it for the same webContents and top-level app frame only.
- `{useSystemPicker: false}` is passed (the system picker is macOS-only and experimental).
- Denial paths run inside one user gesture and passed on the host:
  - bogus source id: `capture:grant` fails with `NOT_FOUND`;
  - `getDisplayMedia` without a grant rejects with `AbortError: Invalid capture constraints`, and the main log shows `Display capture denied: no active grant (no-grant)`, so the rejection comes from our handler and not from missing user activation;
  - one-shot: a granted request works, an immediately following request without a new grant is rejected.
- Electron 44 reports a handler denial (`callback({})`) as `AbortError`. There is no picker, so the renderer maps `AbortError` to `denied`. The `cancelled` error code is used when the caller aborts its own flow (verified by the cancel test).
- Camera: `getUserMedia({video: true})` is rejected with `NotAllowedError` and the main log shows `Denied permission request: media video`. Microphone `getUserMedia({audio})` works. `getDisplayMedia` is not affected by the camera rule.

## Screenshots (measured)

Approach: acquire a live display stream through the grant, take one real frame, encode it as PNG at the frame's own size, never scale. A source thumbnail is never used as the capture. (Phase 04 changed the source of screen and region screenshots to a FULL-SIZE `desktopCapturer` image whose size is verified to equal the display's physical size; a small thumbnail is still never upscaled. See "Pixel-exact screenshot source (phase 04, measured)".)

| Display               | Expected (round(DIP x scale)) | PNG header size | Result |
| --------------------- | ----------------------------- | --------------- | ------ |
| 3440x1440 (primary)   | 3440x1440                     | 3440x1440       | PASS   |
| 2560x1440 (secondary) | 2560x1440                     | 2560x1440       | PASS   |

Findings:

- **`track.getSettings()` is not reliable.** For the secondary monitor it reported 3440x1440 (the primary's size) before the first frame and 2560x1440 after it. The code therefore takes the size from the decoded frame and treats settings as informational.
- Time to first frame in the final run (`docs/evidence/phase02/frame-methods.json`, three runs each, secondary display, first-frame / total ms):

  | Method                                        | Run 1   | Run 2   | Run 3   |
  | --------------------------------------------- | ------- | ------- | ------- |
  | `auto` (default, resolved to track-processor) | 37/79   | 93/138  | 8/66    |
  | `<video>` + requestVideoFrameCallback         | 117/182 | 134/170 | 136/174 |
  | `MediaStreamTrackProcessor`                   | 84/122  | 8/45    | 6/48    |
  | `ImageCapture.grabFrame`                      | 8/57    | 107/143 | 97/135  |

  An earlier run of the same test measured `<video>` at 433 ms and 2015 ms: on a mostly static screen it waits for the next delivered frame and is slow and bursty. All three methods returned the exact physical size every time.

- Acquire time (grant plus `getDisplayMedia`) was 220-500 ms per display in the final run.
- Chosen default: `auto` = track processor first, `<video>` as fallback. `ImageCapture` also worked and is a possible third fallback; it is not used because it is the least standard path for display tracks.
- Rotated displays and scale factors other than 1 were NOT available. `physicalSize` is `round(bounds.size x scaleFactor)` and assumes Electron already reports rotated bounds on Windows; this is unverified for 90/270 rotation and for fractional scaling.

## MediaRecorder formats (measured via `isTypeSupported`)

| Candidate                           | Supported |
| ----------------------------------- | --------- |
| `video/webm;codecs=vp9,opus`        | yes       |
| `video/webm;codecs=vp8,opus`        | yes       |
| `video/webm;codecs=av1,opus`        | yes       |
| `video/webm;codecs=h264,opus`       | yes       |
| `video/mp4;codecs=avc1,mp4a.40.2`   | yes       |
| `video/x-matroska;codecs=avc1,opus` | yes       |

Default (ordered preference, `src/shared/recorder-formats.ts`): VP9+Opus, then VP8+Opus, then H.264+Opus in WebM. Chosen on this host: `video/webm;codecs=vp9,opus`. MP4, Matroska and AV1 are probed and reported but are never the default: WebM is the container this plan persists incrementally, and MP4 delivery remains a real FFmpeg conversion later (never a renamed file). That MP4 is "supported" by MediaRecorder here does not change that plan; fragmented-MP4 behaviour was not evaluated.

## Recording tests (measured, ffprobe/ffmpeg on the saved files)

### Primary display with system audio and test tone (4 s, no microphone)

- Output: WebM, 1 video stream VP9 3440x1440, 1 audio stream Opus 48 kHz stereo; ffprobe/ffmpeg duration 3.95 s.
- `volumedetect`: mean -38.0 dB, max -24.9 dB (final run; threshold was > -50 dB). The tone was audible through Windows loopback. In-app peak level of the system branch: 0.034 (0..1 RMS).
- Frame delivery to the encoder (rVFC counter on the recorded track): 21.2 fps in the final run; 26.9 and 29.2 fps in earlier runs of the same test. 30 fps was requested. Full-size 3440x1440 VP9 at 8 Mbps shows run-to-run variance on this machine; this is a baseline, not a finding about hardware limits (CPU was not sampled; phase 09 does that).
- Size 1.09 MB (final run) for 4 s.
- All four tracks (display video/audio, mixed recorded video/audio) were `live` at stop and `ended` after release.

### Microphone (3 s, with video)

- Default microphone recorded; 1 audio stream present (`audioSources: ['mic']`). Level was low: mean -49.6 dB in the final run (-57.3 dB earlier), in-app peak 0.011. It is not silent, but the room was quiet. No assertion was made on level.

### System audio unavailable

- When loopback is requested and no audio track arrives, `acquireDisplayStream` stops the stream and throws `system-audio-unavailable`; the UI shows the error and no recording starts. This host always provided loopback audio, so the path could not be triggered here. It is covered by code review only (BLOCKED for native proof: needs a host with no active output device).

### Region crop (1280x720 at (100,100) of the primary display, 4 s, no audio)

Reference: a screenshot of the same display taken just before, with the app window placed inside the region. SSIM of the recorded frame at 2 s against the same region of the screenshot, versus a region shifted by (+600,+300) as a control:

| Method                                   | ffprobe size | audio streams | duration | packets (fps) | SSIM region | SSIM shifted control |
| ---------------------------------------- | ------------ | ------------- | -------- | ------------- | ----------- | -------------------- |
| Canvas, requestVideoFrameCallback driver | 1280x720     | 0             | 4.02 s   | 116 (28.9)    | 0.977       | 0.246                |
| Canvas, timer driver                     | 1280x720     | 0             | 4.03 s   | 120 (29.8)    | 0.977       | 0.246                |
| MediaStreamTrackProcessor + visibleRect  | 1280x720     | 0             | 3.95 s   | 94 (23.8)     | 0.979       | 0.251                |

Observations across the three runs of this test (same machine):

- Canvas + timer delivered 29.8-30.0 fps every time. Canvas + rVFC delivered 24-29 fps (it depends on how many frames the source delivers; a keep-alive timer fills gaps, and was tightened to one frame interval after the first run showed 24 fps with a looser threshold). The track-processor path forwards frames at the source's pace: 23.5-29.3 fps in the runs.
- Both approaches produce the correct pixels (visual check above), the exact 1280x720 size, and no audio stream when none was requested.
- The track-processor path requires an even-aligned rectangle (chroma subsampling). The canvas path has no such rule.
- Unlike requestAnimationFrame, both canvas drivers do not depend on rendering; they were tested with the window visible. Behaviour with a hidden recorder window (timer throttling) was **not measured here**; it was measured in phase 05 (see "Recording (phase 05, measured)": about 30 fps in the hidden window with `backgroundThrottling: false`).

**Decision (bounded, evidence based):** the browser pipeline meets MVP needs on this machine. Canvas crop is the shipping candidate for region recording with the timer-backed driver (steady 30 fps). The rVFC driver and the track-processor path are kept as measured alternatives. No native capture backend is justified by this data. Sustained 30-minute behaviour, CPU and memory are not measured here (phase 09).

### Cancellation and cleanup

- Cancelling a recording after 1.5 s (system audio + test tone + region) leaves the UI in `cancelled` and nothing running.
- After every native test, the diagnostics "Resources" counters were asserted to be zero: live tracks, open AudioContexts and active timers/frame loops (including the crop loops and the level sampler). This includes the canvas crop timers.

## Limitations (stated, not all tested)

- Protected content (DRM video such as Netflix in a browser) appears black in the captured frame. Observed on this host in the full-screen screenshot: the Netflix window area is black while everything around it is captured.
- Minimized windows: measured in phase 03 on this host, a minimized window is NOT listed by `desktopCapturer` at all, so it cannot be picked; if a window vanishes or returns an empty (0-size or entirely black) frame between listing and capture, FrameCapt shows "That window is minimized or can't be captured. Restore it and try again." Hidden windows are not listed either.
- The UAC secure desktop, the lock screen and some elevated windows are not capturable by a normal process. Not tested.
- Window capture (phase 03, measured with a framed external Electron window, 640x400 content, outer bounds 656x439): the captured image was 642x432, i.e. the visible window frame, title bar and 1 px border ARE included and the invisible resize/shadow border is NOT (outer bounds minus about 7-8 px per side). The content area was captured sharply. Other themes or DPI settings may change the frame size. A window recording was still not exercised.
- Static screens deliver fewer frames than the requested rate; the recorded frame rate then depends on the method (see above). A constant-frame-rate output needs a timer-backed redraw or an FFmpeg pass.
- Mixed-DPI, rotated displays and fractional scaling were not available.
- Windows loopback audio captures everything the default output plays, including other apps, and the loopback stream follows the default device; device changes during recording were not tested.
- The microphone is a pass only on a host with a device and Windows privacy access; otherwise the test records `skipped`/`error` and does not fail on silence.

### Screenshot fidelity of the getDisplayMedia path (phase 03, measured)

A saturated hard edge (a pure #FF00FF window on a #2A2A2A backdrop) comes out of the worker's frame with about one pixel of color bleed: the pixel just outside the window is (79, 16, 79) instead of (42, 42, 42) and the first pixel inside is (217, 28, 216) instead of (255, 0, 255). Positions and sizes are exact (the edge is at the right pixel), but colors on 1 px edges are not. This is the signature of 4:2:0 chroma subsampling in the video capture pipeline; gray text on a white background is not affected, colored text and thin colored lines are. For comparison, a full-size `desktopCapturer.getSources({ thumbnailSize: <physical size> })` thumbnail of the same display returned the edge exactly ((42, 42, 42) then (255, 0, 255)), took about 400 ms for 3440x1440 and needs no renderer. Both numbers are recorded in docs/evidence/phase03/screenshots-native.json (`edgeSharpness`). This was resolved in phase 04: see "Pixel-exact screenshot source (phase 04, measured)" below.

## Pixel-exact screenshot source (phase 04, measured)

Decision (lead, from the phase-03 findings above): SCREEN and REGION screenshots no longer use `getDisplayMedia` video frames. Main takes one full-size `desktopCapturer` image per display. ADR-014 has the decision text; this section has the numbers. Evidence: `docs/evidence/phase04/screenshots-native.json` (written by `npm run test:native`, redacted; the PNGs next to it show the real desktop and are gitignored).

**Method.** `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: max physical width, height: max physical height }, fetchWindowIcons: false })`, ONE call per flow. Electron fits every thumbnail into the box keeping its aspect ratio, so asking for the largest width and height across displays means no display is downscaled (here 3440 x 1440 covers 3440 x 1440 and 2560 x 1440). Sources are mapped to displays by `display_id`. For each display `image.getSize()` must equal the display's physical size EXACTLY, otherwise that display falls back to the worker's `getDisplayMedia` frame (and a warning is logged). The result is kept as a `NativeImage`: `toPNG()` only when a PNG is really needed (the session original of a whole-screen capture, the crop of a region).

**Window screenshots.** The worker's `getDisplayMedia` frame gives the window's size; main then requests a window thumbnail at exactly that size and uses it only if the returned size matches. On the host the fixture window's frame was 642 x 432 and the thumbnail 642 x 430, so the video frame was used (a window's chroma bleed does not matter for flat colors; coloured text edges stay at the `getDisplayMedia` fidelity). Which path ran is logged (`Screenshot path: ...`) and recorded in the evidence (`capturePaths`).

**Fidelity (tolerance 0).** A #FF00FF window on a #2A2A2A backdrop, screen picker and region on both displays, 40 probes per capture on all four edges: the first pixel inside is exactly (255, 0, 255) and the first pixel outside exactly (42, 42, 42); 0 mismatches in 4 captures (phase 03, getDisplayMedia path: (217, 28, 216) and (79, 16, 79)). Every full-screen and region capture also has a magenta fraction of exactly 1.0 inside the window rectangle (was >= 0.98). Sizes are unchanged: 3440 x 1440 and 2560 x 1440 for the screens, 400 x 300 / 440 x 340 for the regions.

**Timing.** `desktopCapturer.getSources` for both displays at full size: 331-418 ms (3440 x 1440 + 2560 x 1440, 9 flows), one display: 381 and 388 ms. Region click to selection UI (goal < 800 ms):

| Stage (region, 2 displays)                                                      | Phase 03 (worker, getDisplayMedia)                       | Phase 04                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Playwright click -> overlays painted, measured by the test (`regionOverlaysMs`) | 951 ms (display 3590684614), 1961 ms (display 111732923) | 1095 ms and 1062 ms (poll-quantized, see below)        |
| Main: request -> first / last overlay visible                                   | not measured                                             | 668-785 ms / 684-786 ms (median 686 / 701 ms, 9 flows) |
| Main: hide main window + settle                                                 | same code (200 ms settle)                                | 239-262 ms                                             |
| Main: grab both screens                                                         | worker round trips (not measured separately)             | 331-418 ms                                             |

The Playwright number is quantized upwards by `expect.poll` intervals (100 / 250 / 500 / 1000 ms) and by its own polling of two windows, so the main-process measurement (request received -> overlay window made visible, logged as `Selection visible`) is the honest figure: **median 0.70 s, worst 0.79 s over 9 region flows**, so the 800 ms goal is met on this host, with a small margin (an earlier run of the same code had one flow at 831 ms, so treat it as met on average, not guaranteed). What got it there, in order of effect:

1. The exact `desktopCapturer` grab replaced the worker round trip (a window, a stream, a frame, a PNG encode and an IPC copy per screen).
2. The overlay windows are created hidden at the start of the flow, so their renderers load while the main window hides and the screens are grabbed (`overlay:getInit` waits for the frames).
3. The frozen frame goes to the overlays as raw BGRA bytes and is painted on a canvas: PNG encoding of the two screens cost about 220 ms in main and another decode in each overlay.
4. A never-shown window's renderer is throttled to about one frame per second, so the "painted" signal (a double `requestAnimationFrame`) arrived 1-2 s late on some overlays (this also explained the 1961 ms of phase 03). The overlays are now shown at opacity 0 right after the grab and fade in (opacity 1) on `overlay:ready`. Never-shown windows cannot appear in a capture and the grab still happens before any overlay is visible.

Not changed, deliberately: the 200 ms settle after hiding the main window (removing it risks capturing the app window); excluding the main window with `setContentProtection` instead of hiding it was considered and not adopted (not verified to hide it from `desktopCapturer` on this host).

## Recording (phase 05, measured)

Evidence: `docs/evidence/phase05/recordings-native.json` (written by `npm run test:native`, redacted; the WebM files and extracted frames next to it show the real desktop and are gitignored) and the `ui-*.png` screenshots (FrameCapt's own UI only). Same host as above (two displays: 3440x1440 primary at 0,0 and 2560x1440 at 3440,0, both scale 1). Every recording below was driven through the real UI paths: `recorder:start` from the main window, the toolbar's own buttons for pause/resume/stop, the overlay pages for the region selection (Playwright events, not OS input), and analyzed with ffprobe/ffmpeg on the published file.

| Scenario (1080p preset unless noted)                | Output (ffprobe)                         | App active time / file duration   | Measured fps | Audio                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------- | --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| (a) primary display, no audio, 6 s                  | VP9 1920x804, no audio stream            | 6.05 s / 6.06 s                   | 29.7         | none (correct)                                                                                                               |
| (b) system audio + test tone, 3 s + 2 s pause + 3 s | VP9 1920x804 + Opus 48 kHz stereo        | 6.10 s / 6.10 s (wall time 9.7 s) | 30.2         | mean -38.2 dB, -38.0 before the pause, -40.0 after the resume; audio/video length differ by 0.02 s                           |
| (c) microphone only, 6 s                            | VP9 1920x804 + Opus                      | 6.03 s / 6.03 s                   | 30.2         | stream present; this room and microphone gave mean -78.5 dB and a toolbar meter peak of 0.01 (essentially silent; see below) |
| (d) microphone + system audio, 6 s                  | VP9 1920x804 + Opus (one mixed track)    | 6.05 s / 6.03 s                   | 30.2         | mean -30.2 dB; the toolbar system meter followed the tone                                                                    |
| region 1280x720 on the second display, 4 s          | VP9 1280x720                             | 4.04 s / 4.07 s                   | 30.0         | none                                                                                                                         |
| Source preset, primary display, 4 s                 | VP9 3440x1440                            | 4.05 s / 4.03 s                   | 30.5         | none                                                                                                                         |
| window (framed fixture, 640x400 content), 3 s       | VP9 642x432 (as the phase-03 screenshot) | 3.03 s / 3.03 s                   | 30.4         | none; 100% of the content area is the fixture's magenta                                                                      |

Findings:

- **The hidden recorder window is not throttled.** With `backgroundThrottling: false` the never-shown window delivered 29.7-30.5 fps for every recording above (a throttled hidden window would give about 1 fps). The recorder window has no visible state to rely on, so this is a real property of the setup, not of a visible window.
- **Pause is excluded from the file.** Chromium's MediaRecorder removes the paused interval: the file is as long as the active time (paused 2.06 s in the manifest; wall time 9.7 s vs file 6.10 s). Audio resumed at about the same level and stayed in sync (0.02 s length difference).
- **Sizes are even and aspect-fit** (3440x1440 -> 1920x804; 2560x1440 mock -> 1920x1080 in E2E; 1280x720 region exact).
- **Toolbar exclusion: it works on this host.** The toolbar's Stop button is a known red (#DC2626). In the recorded frame of (a), in the toolbar's rectangle (mapped through the 1080p scale, padded 3 px), there were 0 pixels of that color within 28 per channel; the toolbar page itself has 1877 such pixels, which would be about 585 after scaling. Control: with `setContentProtection(false)` set on the toolbar during a separate recording, the same detector found 460 pixels in the recorded frame, so the detector can see the toolbar when it is not excluded. Conclusion: `setContentProtection(true)` excluded the toolbar from the Chromium getDisplayMedia capture on Windows 11 10.0.26300. Not tested: Windows 10, other GPUs/drivers, the window-capture path. The countdown window uses the same call; it is additionally closed before recording starts.
- **Region toolbar placement.** For the 1280x720 region at (100,100) of the second display the toolbar sat at (4054, 832) DIP, below the region (global (3540,100) to (4820,820)), centered under it, not overlapping.
- **Shortest recording.** A 0.3 s recording already produced a playable file (334 KB: MediaRecorder emits a first keyframe at once); the E2E build's synthetic stream needed more than a few milliseconds before the first data, and a stop within about 20 ms ends in "too short to save". No minimum is promised.
- **Latency.** Request to "recording" for a whole screen with no countdown: 1.42-1.49 s (hide the main window, 200 ms settle, display and microphone acquisition, first canvas frame, session creation). Stop click to "completed": 0.14-0.16 s (the file is copied into Videos/FrameCapt; the copy time grows with the file size).
- **Not verified physically:** unplugging a microphone or changing the default output while recording (the code listens for the track `ended` event and `devicechange`; tests inject the engine event), a missing loopback track, 60 fps (the option exists; not measured), mixed-DPI and rotated displays, Windows 10.
- **The microphone on this host was nearly silent in the test** (mean -78.5 dB, meter peak 0.01; phase 02 measured -49.6 and -57.3 dB in the same room). With echo cancellation and noise suppression on, a quiet room is gated to near silence, and a hardware mute or a far microphone would look the same. The path itself is proven (stream present, meter wired, the unit/E2E fake-device test shows levels moving and mute working), but this run did not prove a loud signal end to end from the real microphone; do a manual speaking test on a real desktop session.
- **Un-remuxed WebM:** the files above have no duration header (ffprobe shows none; durations come from decoding) and no seek cues. Phase 06's FFmpeg remux fixes that.

## Limits of this evidence

One machine, a handful of runs, a live desktop (so SSIM values depend on what was on screen), no CPU/memory sampling. Treat fps numbers as a range, not a guarantee.

## Benchmark procedure

Prerequisites: an interactive Windows session with real displays and audio, `ffmpeg` and `ffprobe` on PATH (verification tooling only), Node and `npm ci` done.

1. Close or move anything private; the test captures the real desktop and the app window moves to the primary display during the region test.
2. `npm run test:native` (runs `electron-forge package`, `npm run check:mocks`, then Playwright with `playwright.native.config.ts`).
3. Read `docs/evidence/phase02/*.json`: `environment.json`, `screenshots.json`, `frame-methods.json`, `recording-system-audio.probe.json`, `region-benchmark.json`, `microphone.json`, `denial-paths.json`, `camera-denied.json`. Media files are saved next to them (gitignored).
4. To explore manually: `npm start`, Settings, "Capture diagnostics" (displays, sources, per-display screenshot test, recording test with region/audio/mic/tone, denial probes, format list, resource counters, reveal folder). Files go to `<userData>/diagnostics/`.
5. A different or headless host: the suite fails at the first display or audio step; document that as BLOCKED rather than editing expectations.

Related checks: `npm run check:mocks` (no mock provider in a normal bundle; `node scripts/check-no-mocks.mjs --expect-mock` after a `FRAMECAPT_E2E_BUILD=1` build is the positive control, run once in this phase: it found the mock in the E2E bundle and the normal bundle was clean).

## Concurrent recordings, panels and meeting detection (2026-10-10)

Implemented by ADR-051 to ADR-053 and exercised through unit tests and E2E with the mock capture provider. **Native check pending** for all of it: a real second monitor, minimize and restore of a captured window (Windows Graphics Capture can stay frozen, so the engine re-acquires after 1.5 s), real meeting apps, packaged koffi load. On Linux the window probe is the `desktopCapturer` fallback: titles only, no class, exe, minimized or cloaked facts and no microphone signal.

### Performance: 2–3 concurrent recordings

Not measured yet. TODO: run on a named machine (CPU model, GPU, RAM, monitors, Windows build) with 1080p30 VP9 at default settings, system audio on in the first recording, 5 minutes each, and fill in the table (CPU of the main process plus all renderers and the GPU process from Task Manager or `typeperf`; dropped frames from the recording's frame statistics).

| Machine | Recordings | Panels | Total CPU % | Memory (MB) | Achieved fps | Dropped frames | Notes |
| ------- | ---------- | ------ | ----------- | ----------- | ------------ | -------------- | ----- |
| TODO    | 1          | 0      | TODO        | TODO        | TODO         | TODO           |       |
| TODO    | 2          | 0      | TODO        | TODO        | TODO         | TODO           |       |
| TODO    | 3          | 0      | TODO        | TODO        | TODO         | TODO           |       |
| TODO    | 1          | 3      | TODO        | TODO        | TODO         | TODO           |       |
