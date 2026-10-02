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
| File | matroska,webm, 30 MB, 1397 kbit/s |
| Video | vp9 1920x804, container duration 180.525 s |
| Audio | opus 48000 Hz x2, 180.52 s decoded |
| Frames (decoded) | 5415 in 180.491 s = 30.001 fps |
| Frame gaps | mean 33.33 ms, p99 35 ms, max 42 ms; >100 ms: 0, >250 ms: 0; slowest second 30 frames |
| Audio minus video length | 0.029 s |
| Container minus app active time | 0 s |
| Stop to completed | 0.5 s |

## A/V sync (recorded file)

| Window | beeps | flashes | pairs | mean / median offset (flash - beep) | offsets (ms) |
| --- | --- | --- | --- | --- | --- |
| start (5-50 s) | 5 | 5 | 5 | 52 / 54 ms | 56, 42, 66, 54, 42 |
| end (131-176 s) | 4 | 4 | 4 | 56 / 64 ms | 39, 64, 49, 72 |

**Drift (end - start): 4 ms** (by medians: 10 ms)

## Idle (before recording)

10.3 s with the app open and no recording: -1.012 % of one core by Electron metrics, 0.465 % by the OS CPU time (6 processes).

## CPU (whole process tree, % of one core; the machine has 16 logical cores)

| Metric | Value |
| --- | --- |
| Average | 69.47 % (4.34 % of the machine) |
| Average after warm-up | 69.7 % |
| p95 / max | 74.91 % / 75.07 % |
| OS cross-check (TotalProcessorTime) | 71.42 % of one core |
| Machine total (beacon and harness included) | avg 15 %, max 18.2 % |

| Process type | CPU avg % | CPU max % | working set at warm-up MB | at end MB | private at warm-up MB | at end MB |
| --- | --- | --- | --- | --- | --- | --- |
| Browser | 22.89 | 27.8 | 240.4 | 246.4 | 198.6 | 204.6 |
| GPU | 11.69 | 21.23 | 245.3 | 245.8 | 221.6 | 221.9 |
| Utility | 0.72 | 0.75 | 241.1 | 241.1 | 36.4 | 36.4 |
| Tab | 34.17 | 36.86 | 519.5 | 517.5 | 296.6 | 294.2 |

## Memory (sum over the tree)

| Metric | Value |
| --- | --- |
| Working set at 120 s / at end | 1246.3 MB / 1250.8 MB (growth 4.5 MB, max 1266.4 MB) |
| Private at 120 s / at end | 753.2 MB / 757.1 MB (growth 3.9 MB, max 861.3 MB) |
| Slope after warm-up (working set / private) | 4.16 / 3.798 MB per minute |
| Recorder window JS heap (warm-up / end / max) | 10.7 / 10.7 / 10.7 MB |
| Processes (min-max) | 8-8 |

## Queue, disk, resources

| Metric | Value |
| --- | --- |
| Renderer queue high-water | 1 chunks, 479057 bytes (limits 16 chunks / 67108864 bytes) |
| Main queue high-water / slowest write | 1 / 26.9 ms |
| Chunks written | 175 |
| Disk growth of stream.webm | 9.97 MB per minute, 30 MB at the end; final file 30.1 MB |
| Recorder window during recording: live tracks / audio contexts / loops | [4] / [1] / [[2,["crop-timer","level-sampler"]]] |
| After stop | {"liveTracks":0,"openAudioContexts":0,"activeLoops":0,"loopNames":[],"activeRecorders":0} |
| Cleanup | session folder removed: true; partial files left: 0 |

