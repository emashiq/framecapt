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
| File | matroska,webm, 86 MB, 4004 kbit/s |
| Video | vp9 1920x804, container duration 180.584 s |
| Audio | opus 48000 Hz x2, 180.58 s decoded |
| Frames (decoded) | 5414 in 180.558 s = 29.985 fps |
| Frame gaps | mean 33.34 ms, p99 35 ms, max 135 ms; >100 ms: 1, >250 ms: 0; slowest second 30 frames |
| Audio minus video length | 0.022 s |
| Container minus app active time | 0 s |
| Stop to completed | 0.5 s |

## A/V sync (recorded file)

| Window | beeps | flashes | pairs | mean / median offset (flash - beep) | offsets (ms) |
| --- | --- | --- | --- | --- | --- |
| start (5-50 s) | 6 | 5 | 6 | 30 / 102 ms | 114, 103, 90, 78, 102, -307 |
| end (131-176 s) | 5 | 4 | 4 | 89.5 / 96 ms | 97, 88, 77, 96 |

**Drift (end - start): 59.5 ms** (by medians: -6 ms)

## Idle (before recording)

30.5 s with the app open and no recording: 0.404 % of one core by Electron metrics, 0.616 % by the OS CPU time (6 processes).

## CPU (whole process tree, % of one core; the machine has 16 logical cores)

| Metric | Value |
| --- | --- |
| Average | 75.77 % (4.74 % of the machine) |
| Average after warm-up | 76.33 % |
| p95 / max | 78.36 % / 79.1 % |
| OS cross-check (TotalProcessorTime) | 76.42 % of one core |
| Machine total (beacon and harness included) | avg 16.8 %, max 26.6 % |

| Process type | CPU avg % | CPU max % | working set at warm-up MB | at end MB | private at warm-up MB | at end MB |
| --- | --- | --- | --- | --- | --- | --- |
| Browser | 14.32 | 24.08 | 236.7 | 237.6 | 192.4 | 193.3 |
| GPU | 14.66 | 24.22 | 272.9 | 272.9 | 783.3 | 784.1 |
| Utility | 0.75 | 0.79 | 248.1 | 248.1 | 36.5 | 36.5 |
| Tab | 46.04 | 48.95 | 541.3 | 541.9 | 308.1 | 308.7 |

## Memory (sum over the tree)

| Metric | Value |
| --- | --- |
| Working set at 120 s / at end | 1299 MB / 1300.5 MB (growth 1.5 MB, max 1314.5 MB) |
| Private at 120 s / at end | 1320.3 MB / 1322.6 MB (growth 2.3 MB, max 1340.7 MB) |
| Slope after warm-up (working set / private) | 1.985 / 2.295 MB per minute |
| Recorder window JS heap (warm-up / end / max) | 13.6 / 13.6 / 13.6 MB |
| Processes (min-max) | 8-8 |

## Queue, disk, resources

| Metric | Value |
| --- | --- |
| Renderer queue high-water | 1 chunks, 755055 bytes (limits 16 chunks / 67108864 bytes) |
| Main queue high-water / slowest write | 1 / 33.3 ms |
| Chunks written | 175 |
| Disk growth of stream.webm | 28.53 MB per minute, 86 MB at the end; final file 86.2 MB |
| Recorder window during recording: live tracks / audio contexts / loops | [4] / [1] / [[2,["crop-timer","level-sampler"]]] |
| After stop | {"liveTracks":0,"openAudioContexts":0,"activeLoops":0,"loopNames":[],"activeRecorders":0} |
| Cleanup | session folder removed: true; partial files left: 0 |

