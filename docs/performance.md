# Performance and reliability measurements (phase 09)

All numbers are from one machine, measured on 2026-10-02 with the code of this tree (production bundle, not the mock/E2E
build). Nothing here is a guarantee for other hardware. PASS/FAIL is stated against thresholds that were **derived from the
measured baseline** (section 6), so a PASS means "no regression from this baseline" and, where a hard target exists
(frame rate, A/V sync), that the target is met.

## 1. Environment

|                |                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS             | Windows 11 Pro 10.0.26300                                                                                                                                                                      |
| CPU / RAM      | AMD Ryzen 7 7700 (8 cores, 16 logical), 63.1 GiB                                                                                                                                               |
| Displays       | 3440x1440 @1x (primary, recorded) and 2560x1440 @1x                                                                                                                                            |
| App            | Framelet 0.1.0, Electron 44.5.1 (Chromium 152.0.7977.130), launched as `electron .` on `.vite/build` with a temporary userData (Playwright's Electron driver attached, as in the native tests) |
| FFmpeg         | bundled 9.0.2 essentials (finalization); the same binaries analysed the output                                                                                                                 |
| Recording      | primary display, **1080p preset** (3440x1440 is fitted to 1920x804), **30 fps**, system audio (WASAPI loopback) on, microphone off, VP9 + Opus WebM                                            |
| Screen content | a test beacon (see 2) plus, in the headline run, a 640x360 animated panel (scrolling text, bouncing shapes, gradient) so the encoder has real motion; the rest is the live desktop             |
| Duration       | **30 minutes** (headline), plus 3-minute runs for tooling and before/after comparisons                                                                                                         |

## 2. Method (`npm run bench:recording`, `scripts/bench-recording.mjs`)

`DURATION_MIN=30 npm run bench:recording` (`MOTION=0` for a static desktop, `BENCH_KEEP_DIR=<dir>` keeps the recording).
It refuses to run unless `check-no-mocks` passes on the build, starts `scripts/bench/sync-beacon.mjs` (a separate Electron
process, not part of the app), launches the app, measures 30 s of idle, records the primary display for `DURATION_MIN`, then
stops, waits for finalization and probes the file.

- **Process tree**: every 5 s `app.getAppMetrics()` (CPU %, working set, private bytes, type of every Electron process;
  8 processes during recording), summed. **Units**: Electron reports `percentCPUUsage` as a share of the _whole machine_;
  the script multiplies by the 16 logical cores to give "% of one core" and verified it against the OS's own CPU time
  (`TotalProcessorTime` of every process, new ones counted from zero): 73.66 % vs 73.8 % over the 30 minutes.
- **Recorder queue / chunks / disk**: from the session manifest (`stats`, updated every 5 s or 10 chunks and kept in the
  completion record) and the size of `stream.webm` every 5 s; the renderer's own resource counters (live tracks, audio
  contexts, timer/frame loops) and JS heap of the hidden recorder window.
- **Output**: `ffprobe` (container, dims, bit rate), packet timing (frame gaps), a full decode with `-count_frames`, the
  decoded audio length.
- **A/V sync**: the beacon plays a quiet 440 Hz tone and, every 10.0111 s, a 150 ms 1 kHz beep while a small always-on-top
  window flashes white; both are driven by one clock (the audio context's output timestamp). From the **recorded file**
  the script finds beep onsets (1 kHz band, `silencedetect`) and flash onsets (mean brightness of the beacon crop) in a
  120 s window at the start and one at the end; offset = flash minus beep; **drift = mean offset at the end minus at the
  start** (constant latencies cancel). 10.0111 s makes successive beeps fall on different phases of the 30 fps grid, which
  averages the 33 ms frame quantization out.
- **Caveats**: the content is partly generated (the beacon) but every frame in the file is real display capture; Playwright's
  CDP attachment adds a little overhead to the renderer; "Machine total" CPU includes the beacon and the harness; the
  rest of the desktop was idle but not controlled.

## 3. Results: 30 minutes, 1080p / 30 fps, system audio, with motion

Evidence: `docs/evidence/phase09/bench-2026-10-02-30min-motion.{json,md}` (360 samples, redacted).

| Metric                              | Result                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Output                              | WebM, 857 MB (3.99 Mbit/s), VP9 1920x804 + Opus 48 kHz stereo, container duration 1800.589 s = app active time (diff 0 s)                                                                              |
| Frames                              | 53,511 decoded in 1800.6 s = **29.72 fps** (53,512 packets); p50 gap 33 ms, p99 36 ms, **max gap 69 ms**, 0 gaps over 100 ms; 45 of 1800 seconds had fewer than 25 frames (slowest second 20)          |
| Audio vs video length               | -0.03 s                                                                                                                                                                                                |
| **A/V sync**                        | 12 beep/flash pairs per window; start mean offset 69.6 ms, end 80.0 ms; **drift +10.4 ms** (by medians +10 ms). Absolute flash-after-beep offset about 70-80 ms (display capture latency; constant)    |
| CPU, whole tree                     | avg **73.7 %** of one core (4.6 % of the machine), after warm-up 73.8 %, p95 77.3 %, max 79.0 %. Split: Tab (recorder renderer: canvas + VP9 encode) 40.5 %, Browser 22.0 %, GPU 10.4 %, utility 0.7 % |
| Memory, working set (sum)           | 1254.8 MB at 2 min, 1286.7 MB at 30 min (**+31.9 MB**), max 1288.3 MB; plateau from about minute 15 (5-minute averages: 1259, 1267, 1275, 1280, 1280, 1280 MB)                                         |
| Memory, private bytes (sum)         | 757.1 MB at 2 min, 778.8 MB at the end (**+21.7 MB**), max 841.1 MB (a transient early); 5-minute averages 763, 766, 769, 773, 772, 772 MB                                                             |
| Slope                               | working set 0.81 MB/min from minute 2 (0.35 MB/min from minute 10); private 0.42 (0.19 from minute 10). Recorder window JS heap 13.6 MB flat (12.1 at the end)                                         |
| Recorder queue                      | renderer **high-water 1 chunk / 795 KB** (limits 16 chunks / 64 MB), main queue high-water 1, slowest chunk write 44.4 ms, 1,760 chunks of about 0.5 MB                                                |
| Disk                                | `stream.webm` grew 28.5 MB/min (897.9 MB), constant; final file 856.8 MB                                                                                                                               |
| Timers / resources during recording | 2 loops (`crop-timer`, `level-sampler`), 4 live tracks, 1 audio context, 1 recorder, constant for all 360 samples; **0 of each after stop**                                                            |
| Finalization                        | stop -> completed in **1.0 s** (remux of 898 MB + probe + publish); no partial file, session folder removed                                                                                            |
| Processes after the run             | 0 `electron.exe` left behind                                                                                                                                                                           |

Reading: the pipeline is steady for the whole half hour: no growing queue (never more than one chunk waiting), no timer or
track accumulation, memory settles after about 15 minutes (the early rise is the encoder and canvas warming up and the
GPU process caching; the last 15 minutes are flat within noise), A/V sync does not drift measurably (+10 ms, inside the
measurement resolution of about +-15 ms), and the frame rate is 29.7 fps average with a worst frame gap of 69 ms.

### Other 30-minute-relevant observations

- About 0.9 % of frames are missing against an exact 30 fps (53,511 of 54,018) and 2.5 % of seconds dip below 25 fps, but never
  as a visible stall (max gap 69 ms). Likely cause: the draw timer and `captureStream(30)` sample at the same rate and
  occasionally alias; the static run is exact (30.001 fps). A candidate fix is `captureStream(0)` with one
  `track.requestFrame()` per draw. It was **not applied**: it is inside the threshold, and changing the capture clock after the
  30-minute run would have invalidated this baseline.
- CPU is almost independent of what is on screen: the 3-minute static-desktop run (`bench-2026-10-02-3min-static`) used
  69.5 % of a core (OS cross-check 71.4 %), 30.001 fps, 10 MB/min of disk, +4 ms drift; the animated run 73.7 %. The
  fixed cost is capture, the canvas fit to 1080p and the VP9 software encoder, not the picture.
- 1080p of a 3440x1440 display at 30 fps therefore costs about 4.6 % of this 16-thread machine and 0.8 GB of memory; on a
  4-core laptop the same work would be about 18 % of the CPU (linear estimate, not measured).

## 4. Leak and hot-path investigation

| Question                       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Memory leak over 30 minutes    | None found. Working set +32 MB and private +22 MB between minute 2 and 30, all of it before minute 15 (plateau afterwards); JS heap flat; recorder queue never above 1 chunk; all resources released at stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | section 3                                                                                       |
| Timers / intervals             | Recording runs exactly two loops: the 30 fps canvas draw timer (self-correcting `setTimeout`, no `requestAnimationFrame`: hidden windows throttle it) and the 10 Hz level sampler, which exists **only while a toolbar is visible** and recording (`engine.ts` `updateSampler`, `controller.ts` `setLevels`). Main side: one 1 s tray tooltip timer while recording (`desktop.ts:209`), the 30 s disk watch (`unref`'d, stops when idle), debounced settings write. No thumbnail polling anywhere: history thumbnails are made once per added item (queued, one at a time) and screenshots send their own flattened thumbnail. The 500 ms diagnostics poll exists only while Settings > Advanced is open. | `grep -rn "setInterval\|setTimeout\|requestAnimationFrame" src`; loop counters in the benchmark |
| Per-frame allocations / canvas | One canvas, one 2D context (`alpha: false`), created once; each frame is a single `drawImage` of the `<video>`. The only per-frame allocation (a source-rectangle object when there is no crop) was removed (`region-crop.ts`). Chunks are read with `blob.arrayBuffer()` once per second, sent one at a time, bounded at 16 chunks / 64 MB.                                                                                                                                                                                                                                                                                                                                                              | `src/renderer/capture/region-crop.ts`, `chunk-uploader.ts`                                      |
| Largest cost                   | The recorder renderer (40 %), the browser process (22 %: display capture) and the GPU process. The GPU process held **784 MB of private memory** (full-size 3440x1440 frames).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | per-type table                                                                                  |

### Optimization made (evidence-backed)

The capture was requested at full display size and scaled to 1080p in the canvas. For full-screen and window recordings
the capturer is now asked for at most the preset's size (`getDisplayMedia` `width/height` max, aspect kept;
`acquireDisplayStream({ maxSize })` in `src/renderer/capture/stream.ts`, used from `engine.ts`); region recordings keep the
full-resolution frame they need to crop. 3-minute runs, same machine and content (animated):

|                                  | before               | after                  |
| -------------------------------- | -------------------- | ---------------------- |
| CPU, whole tree (OS cross-check) | 75.8 % (76.4 %)      | 72.2 % (72.8 %)        |
| GPU process private memory       | 784 MB               | 220 MB                 |
| Whole-tree private memory        | 1322.6 MB            | 807.3 MB (**-515 MB**) |
| Working set                      | 1300.5 MB            | 1292.9 MB (unchanged)  |
| Output                           | 1920x804, 29.985 fps | 1920x804, 29.991 fps   |

Evidence: `bench-2026-10-02-3min-motion-before-maxsize.*` and `...-after-maxsize.*` (the _before_ file was produced by an
earlier version of the analysis that counted one spurious beep; its A/V numbers are not to be used, its CPU/memory numbers
are valid). The CPU change is within run-to-run noise (about 3 %); the committed-memory drop is real. Output dimensions are
unchanged and the native suite (dimensions, frame rate, pixel checks) passed with the change.

## 5. Other measurements

| Measurement                                                          | Value                                                                                                                                                                                                                                                             | Source                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Idle CPU, app open, no recording (this phase)                        | **0.05 % of one core** by the OS CPU time, 0.40 % by Electron's metrics (30 s, 6 processes; 3-minute runs: 0.29-0.62 %)                                                                                                                                           | `bench-...-30min-motion.json` `idle`                                                                              |
| Idle CPU, phase 08 (all windows open, recorder worker present)       | reported there as "0.041 % of one core"; **that figure is machine-normalized** (Electron's `percentCPUUsage` is a share of all 16 threads), so the same measurement is about **0.66 % of one core**. Still near zero; the test's "< 2 %" bound was never at risk. | `docs/evidence/phase08/desktop-native.json`, correction by this phase                                             |
| Screenshot: region button click -> overlays painted on both displays | main-process measure 683-752 ms (median about 700 ms) over 9 runs; Playwright-polled 1.09 s                                                                                                                                                                       | native run of this phase (`screenshots-native.json`, regenerated and restored to the committed copy); goal 800 ms |
| Screenshot: screen pick -> editor-ready result                       | 1.51 s (both displays; includes the pick overlay 0.49 s)                                                                                                                                                                                                          | same                                                                                                              |
| Screenshot: region confirm -> result                                 | 95-105 ms                                                                                                                                                                                                                                                         | same                                                                                                              |
| Screenshot: window capture                                           | 2.56 s (video-frame path; desktopCapturer thumbnails are not pixel-exact for windows)                                                                                                                                                                             | same                                                                                                              |
| Recording start (request -> recording), stop (stop -> completed)     | start about 1 s with countdown off; stop 0.5 s (3 min) / 1.0 s (30 min)                                                                                                                                                                                           | benchmark runs                                                                                                    |

## 6. Thresholds (derived from the baseline) and status

Set from the 30-minute headline run (`bench-...-30min-motion`) unless noted. Headroom is stated; a future benchmark on the same
hardware that exceeds a threshold is a regression to investigate. Hard targets from the project contract are marked.

| #   | Metric                                                                                            | Measured                                | Threshold                                                  | Status   |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- | -------- |
| 1   | CPU, whole tree, average, % of one core                                                           | 73.7                                    | <= 92 (measured + 25 %)                                    | **PASS** |
| 2   | CPU p95                                                                                           | 77.3                                    | <= 97                                                      | **PASS** |
| 3   | Working set growth, minute 2 -> end                                                               | +31.9 MB                                | <= 64 MB                                                   | **PASS** |
| 4   | Private bytes growth, minute 2 -> end                                                             | +21.7 MB                                | <= 50 MB                                                   | **PASS** |
| 5   | Working set slope from minute 10                                                                  | 0.35 MB/min                             | <= 0.7 MB/min                                              | **PASS** |
| 6   | Working set maximum (sum)                                                                         | 1288 MB                                 | <= 1600 MB                                                 | **PASS** |
| 7   | Recorder queue high-water (renderer / main)                                                       | 1 chunk, 0.8 MB / 1                     | <= 4 chunks, <= 8 MB / <= 4 (hard limit 16 chunks / 64 MB) | **PASS** |
| 8   | Slowest chunk write                                                                               | 44 ms                                   | <= 250 ms                                                  | **PASS** |
| 9   | Output frame rate (hard target: usable ~30 fps)                                                   | 29.72 fps                               | >= 29.0                                                    | **PASS** |
| 10  | Longest frame gap                                                                                 | 69 ms                                   | <= 250 ms (0 gaps over 100 ms)                             | **PASS** |
| 11  | Seconds with < 25 frames                                                                          | 45 of 1800 (2.5 %)                      | <= 5 %                                                     | **PASS** |
| 12  | A/V drift over 30 min (hard target: no material drift)                                            | +10.4 ms                                | \|drift\| <= 100 ms                                        | **PASS** |
| 13  | Audio length minus video length                                                                   | -0.03 s                                 | \|diff\| <= 0.1 s                                          | **PASS** |
| 14  | Container duration minus app active time                                                          | 0 s                                     | <= 0.05 s                                                  | **PASS** |
| 15  | Stop -> completed, 30 min recording                                                               | 1.0 s                                   | <= 10 s                                                    | **PASS** |
| 16  | Resources after stop (tracks, audio contexts, loops, recorders), leftover processes/partial files | 0 / 0 / 0 / 0, 0, 0                     | all 0                                                      | **PASS** |
| 17  | Idle CPU, app open                                                                                | 0.05-0.4 % (phase 08 corrected: 0.66 %) | <= 1 % of one core                                         | **PASS** |
| 18  | Region click -> overlays (screenshot)                                                             | about 0.70 s                            | <= 1.0 s                                                   | **PASS** |
| 19  | 30-minute 1080p/30 recording completes on real hardware (checklist)                               | yes                                     | -                                                          | **PASS** |

Not measured (honest gaps): region recording and `source` preset at 30 minutes, 60 fps, microphone mix at length, other
hardware (integrated GPU, 4 cores), mixed DPI. The shorter phase 05 runs covered those modes for correctness, not for
long-run cost.

## 7. Memory and CPU by process type (30 min)

| Process                                                | CPU avg / max (% of one core) | Working set 2 min -> end | Private 2 min -> end |
| ------------------------------------------------------ | ----------------------------- | ------------------------ | -------------------- |
| Browser                                                | 22.0 / 28.1                   | 247 -> 252 MB            | 204 -> 208 MB        |
| GPU                                                    | 10.4 / 20.7                   | 246 -> 250 MB            | 222 -> 223 MB        |
| Tab (recorder renderer + main window + others, summed) | 40.5 / 44.4                   | 518 -> 540 MB            | 296 -> 312 MB        |
| Utility (3 processes)                                  | 0.7 / 0.9                     | 244 -> 245 MB            | 36 -> 36 MB          |

## 8. Verification of this phase (commands and exact results)

| Command                                   | Result                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                            | exit 0                                                                                                                                                                                                         |
| `npm run typecheck`                       | exit 0                                                                                                                                                                                                         |
| `npm test`                                | 51 files, 719 tests passed (final run, after all code changes)                                                                                                                                                 |
| `npm run test:e2e`                        | 150 tests: 149 passed on the first run, 1 failed because an E2E assertion encoded the old "unknown keys are dropped" behaviour (`desktop.spec.ts`, now asserts `INVALID_PAYLOAD`); that test then passed alone |
| `npm run test:native`                     | **46 passed (7.2 min)**: the 38 earlier native tests plus 8 new failure-mode tests                                                                                                                             |
| `npm run check:mocks`                     | `check-no-mocks: OK (3 bundle files and 1 app.asar scanned, no mock or test-hook markers)`                                                                                                                     |
| `npm run smoke:packaged`                  | 9 PASS on `out/Framelet-win32-x64/Framelet.exe` (renderer loads, CSP meta present, bridge = `invoke,on`, no Node globals, strict payload refused, unknown channel refused, network request blocked)            |
| `DURATION_MIN=30 npm run bench:recording` | completed, 0 stray processes; evidence in `docs/evidence/phase09/`                                                                                                                                             |
| `npm audit --omit=dev` / `npm audit`      | found 0 vulnerabilities / found 0 vulnerabilities                                                                                                                                                              |

Earlier phases' committed evidence files that the native/E2E runs regenerate were restored with
`git checkout -- docs/evidence/phase02 ... phase08`.

## 9. Reproduce

```
npm run package                      # the real (non-mock) build
npm run check:mocks
DURATION_MIN=30 npm run bench:recording     # about 36 minutes, needs an interactive desktop and ~3 GB free
npx playwright test -c playwright.native.config.ts failure-modes     # the failure-mode exercise
npm run smoke:packaged
```
