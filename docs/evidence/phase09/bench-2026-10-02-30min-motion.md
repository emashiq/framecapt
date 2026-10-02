# Recording benchmark 30 min (2026-10-02)

Real capture of the primary display, 1080p / 30 fps, system audio on (a tone plus a beep every 10 s, with a flashing window for A/V sync). production bundle (.vite/build), check-no-mocks OK, launched as `electron .` with a temporary userData.

## Environment

- OS: Windows_NT 10.0.26300 (Windows 11 Pro)
- CPU: AMD Ryzen 7 7700 8-Core Processor (16 logical cores), RAM 63.1 GiB
- Electron 44.5.1 (Chromium 152.0.7977.130), app 0.1.0; ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
- Displays: 2560x1440 @1x, 3440x1440 @1x (primary, recorded)
- Duration: 1800 s of wall time; 360 samples every 5 s

## Output

| Property | Value |
| --- | --- |
| File | matroska,webm, 857 MB, 3991 kbit/s |
| Video | vp9 1920x804, container duration 1800.589 s |
| Audio | opus 48000 Hz x2, 1800.56 s decoded |
| Frames (decoded) | 53511 in 1800.59 s = 29.719 fps |
| Frame gaps | mean 33.65 ms, p99 36 ms, max 69 ms; >100 ms: 0, >250 ms: 0; slowest second 20 frames |
| Audio minus video length | -0.03 s |
| Container minus app active time | 0 s |
| Stop to completed | 1 s |

## A/V sync (recorded file)

| Window | beeps | flashes | pairs | mean / median offset (flash - beep) | offsets (ms) |
| --- | --- | --- | --- | --- | --- |
| start (5-125 s) | 12 | 12 | 12 | 69.6 / 68 ms | 101, 57, 78, 68, 88, 79, 66, 90, 46, 66, 55, 41 |
| end (1676-1796 s) | 12 | 12 | 12 | 80 / 78 ms | 99, 89, 78, 68, 89, 78, 67, 53, 76, 99, 55, 109 |

**Drift (end - start): 10.4 ms** (by medians: 10 ms)

## Idle (before recording)

30.6 s with the app open and no recording: 0.398 % of one core by Electron metrics, 0.049 % by the OS CPU time (6 processes).

## CPU (whole process tree, % of one core; the machine has 16 logical cores)

| Metric | Value |
| --- | --- |
| Average | 73.66 % (4.6 % of the machine) |
| Average after warm-up | 73.79 % |
| p95 / max | 77.26 % / 79.02 % |
| OS cross-check (TotalProcessorTime) | 73.8 % of one core |
| Machine total (beacon and harness included) | avg 16 %, max 27.3 % |

| Process type | CPU avg % | CPU max % | working set at warm-up MB | at end MB | private at warm-up MB | at end MB |
| --- | --- | --- | --- | --- | --- | --- |
| Browser | 22.01 | 28.14 | 247 | 252.3 | 203.7 | 207.5 |
| GPU | 10.39 | 20.68 | 246.1 | 250.4 | 221.7 | 223.4 |
| Utility | 0.73 | 0.86 | 244.1 | 244.5 | 36 | 36 |
| Tab | 40.54 | 44.42 | 517.6 | 539.5 | 295.7 | 311.9 |

## Memory (sum over the tree)

| Metric | Value |
| --- | --- |
| Working set at 120 s / at end | 1254.8 MB / 1286.7 MB (growth 31.9 MB, max 1288.3 MB) |
| Private at 120 s / at end | 757.1 MB / 778.8 MB (growth 21.7 MB, max 841.1 MB) |
| Slope after warm-up (working set / private) | 0.813 / 0.422 MB per minute |
| Recorder window JS heap (warm-up / end / max) | 13.6 / 12.1 / 13.6 MB |
| Processes (min-max) | 8-8 |

## Queue, disk, resources

| Metric | Value |
| --- | --- |
| Renderer queue high-water | 1 chunks, 795248 bytes (limits 16 chunks / 67108864 bytes) |
| Main queue high-water / slowest write | 1 / 44.4 ms |
| Chunks written | 1760 |
| Disk growth of stream.webm | 28.54 MB per minute, 856 MB at the end; final file 856.8 MB |
| Recorder window during recording: live tracks / audio contexts / loops | [4] / [1] / [[2,["crop-timer","level-sampler"]]] |
| After stop | {"liveTracks":0,"openAudioContexts":0,"activeLoops":0,"loopNames":[],"activeRecorders":0} |
| Cleanup | session folder removed: true; partial files left: 0 |

