# Recording benchmark 3 min (2026-10-02)

Real capture of the primary display, 1080p / 30 fps, system audio on (a tone plus a beep every 10 s, with a flashing window for A/V sync). production bundle (.vite/build), check-no-mocks OK, launched as `electron .` with a temporary userData.

## Environment

- OS: Windows_NT 10.0.26300 (Windows 11 Pro)
- CPU: AMD Ryzen 7 7700 8-Core Processor (16 logical cores), RAM 63.1 GiB
- Electron 44.5.1 (Chromium 152.0.7977.130), app 0.1.0; ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
- Displays: 2560x1440 @1x, 3440x1440 @1x (primary, recorded)
- Duration: 180 s of wall time; 36 samples every 5 s

## Output

| Property | Value |
| --- | --- |
| File | matroska,webm, 86 MB, 3983 kbit/s |
| Video | vp9 1920x804, container duration 180.583 s |
| Audio | opus 48000 Hz x2, 180.58 s decoded |
| Frames (decoded) | 5415 in 180.556 s = 29.991 fps |
| Frame gaps | mean 33.34 ms, p99 35 ms, max 100 ms; >100 ms: 0, >250 ms: 0; slowest second 30 frames |
| Audio minus video length | 0.024 s |
| Container minus app active time | 0 s |
| Stop to completed | 0.5 s |

## A/V sync (recorded file)

| Window | beeps | flashes | pairs | mean / median offset (flash - beep) | offsets (ms) |
| --- | --- | --- | --- | --- | --- |
| start (5-50 s) | 5 | 5 | 5 | 61.2 / 61 ms | 52, 39, 61, 83, 71 |
| end (131-176 s) | 4 | 4 | 4 | 86.5 / 92 ms | 70, 92, 81, 103 |

**Drift (end - start): 25.3 ms** (by medians: 31 ms)

## Idle (before recording)

10.4 s with the app open and no recording: 0.317 % of one core by Electron metrics, 0.289 % by the OS CPU time (6 processes).

## CPU (whole process tree, % of one core; the machine has 16 logical cores)

| Metric | Value |
| --- | --- |
| Average | 72.22 % (4.51 % of the machine) |
| Average after warm-up | 72.77 % |
| p95 / max | 74.47 % / 75.76 % |
| OS cross-check (TotalProcessorTime) | 72.77 % of one core |
| Machine total (beacon and harness included) | avg 15.9 %, max 21 % |

| Process type | CPU avg % | CPU max % | working set at warm-up MB | at end MB | private at warm-up MB | at end MB |
| --- | --- | --- | --- | --- | --- | --- |
| Browser | 21.5 | 27.9 | 245.2 | 244.5 | 200.9 | 200 |
| GPU | 10.49 | 20.56 | 249.6 | 249.6 | 220.2 | 220.3 |
| Utility | 0.81 | 0.88 | 271.3 | 271.3 | 83.3 | 83.3 |
| Tab | 39.42 | 42.47 | 527.1 | 527.5 | 303.6 | 303.7 |

## Memory (sum over the tree)

| Metric | Value |
| --- | --- |
| Working set at 120 s / at end | 1293.2 MB / 1292.9 MB (growth -0.3 MB, max 1327.5 MB) |
| Private at 120 s / at end | 808 MB / 807.3 MB (growth -0.7 MB, max 920.3 MB) |
| Slope after warm-up (working set / private) | -0.534 / -1.002 MB per minute |
| Recorder window JS heap (warm-up / end / max) | 13.6 / 13.6 / 13.6 MB |
| Processes (min-max) | 8-8 |

## Queue, disk, resources

| Metric | Value |
| --- | --- |
| Renderer queue high-water | 1 chunks, 760475 bytes (limits 16 chunks / 67108864 bytes) |
| Main queue high-water / slowest write | 1 / 74.8 ms |
| Chunks written | 175 |
| Disk growth of stream.webm | 28.37 MB per minute, 85 MB at the end; final file 85.7 MB |
| Recorder window during recording: live tracks / audio contexts / loops | [4] / [1] / [[2,["crop-timer","level-sampler"]]] |
| After stop | {"liveTracks":0,"openAudioContexts":0,"activeLoops":0,"loopNames":[],"activeRecorders":0} |
| Cleanup | session folder removed: true; partial files left: 0 |

