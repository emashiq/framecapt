# Recording persistence, backpressure and recovery

Status: phase 06. Written before the implementation; the "Measured limits" section at the end was filled in from real runs.

## 1. Why chunks are not files

`MediaRecorder` with a `timeslice` (FrameCapt uses 1 s) emits **one continuous WebM byte stream, cut at arbitrary points**.

- The first `dataavailable` blob carries the EBML header, `Info`, `Tracks` and the first `Cluster` (partially).
- Every later blob is a continuation: a piece of a `Cluster`, sometimes ending in the middle of a `SimpleBlock`.
- Pausing and resuming the **same** recorder keeps the same stream (no new header). A new recorder instance would start a new header and a new timeline, so chunks of two recorders can never be joined by appending.
- The live stream has **no `Duration` and no `Cues`** (the recorder cannot seek back to write them), so players cannot show a length or seek reliably.

Consequences, which the code follows:

1. A chunk is never treated as a standalone file. Chunks are appended, in strict sequence, to a single `stream.webm`.
2. Sequence numbers start at 0 per session and are gap-free. Main rejects gaps, accepts an idempotent retry of the last chunk and rejects any other duplicate.
3. The only supported finalization is a **remux with FFmpeg `-c copy`** (no re-encode, no quality loss, no re-timing): it rewrites the container with `Duration` and `Cues`.
4. A stream cut off by a crash is still parseable up to its last complete `Cluster`; the remux of such a file is **best effort** (see section 6).

## 2. On-disk layout

```
<userData>/recordings/
  <sessionId>/               one per recording (a random uuid; nothing else is accepted)
    manifest.json            atomic: manifest.json.tmp + fsync + rename
    stream.webm              append-only live stream (one fsync when the session stops)
    finalize.log             last 64 KB of ffmpeg stderr, only after a failed remux
  completed/<sessionId>.json small record (output path, duration, size) kept for history linking
<Videos>/FrameCapt/
  FrameCapt 2026-10-02 at 14.05.09.webm        the finished, remuxed recording
  .framecapt-<sessionId>.partial.webm          temporary remux output (app-owned, see 4.3)
```

After a successful finalization the session directory is deleted (`stream.webm` is **not** kept as a duplicate); only `completed/<id>.json` stays.

## 3. Manifest v1

`manifest.json` (zod schema in `src/main/recording/manifest.ts`): `sessionId, createdAt, updatedAt, state, mime, source {kind, displayId?, name}, options, width, height, chunksWritten, bytesWritten, lastSeq, pausedIntervals, stats, appVersion, truncated?, endReason?, error? {code, message}, finalize? {outputDir, fileName, partialPath, startedAt}, outputPath?, unindexed?`.

States: `recording -> stopping -> stopped -> finalizing -> completed`; side exits `failed`, `recovered`, `discarded`.

| State        | Meaning                                                     | On next start                                  |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| `recording`  | App died while recording                                    | recoverable candidate                          |
| `stopping`   | Stop requested, last chunks not yet acknowledged            | recoverable candidate                          |
| `stopped`    | All chunks written and fsynced, not yet remuxed             | recoverable candidate                          |
| `finalizing` | Remux running (or interrupted)                              | matching `.partial` deleted, remux re-run once |
| `completed`  | Output published and verified; the directory is about to go | leftover directory removed                     |
| `failed`     | Write error / remux failed; `stream.webm` kept              | recoverable candidate                          |
| `recovered`  | User recovered it                                           | skipped                                        |
| `discarded`  | User discarded it                                           | directory removed if it still exists           |

The manifest is rewritten every 5 s or 10 chunks and at every state change. A stale manifest never hides data: recovery reads the real size of `stream.webm`. A corrupt or unparsable manifest is moved to `manifest.corrupt.json` and the session is reported as `unknown` (still recoverable when `stream.webm` has data; the directory name is the only trusted identity).

## 4. Writing and backpressure

### 4.1 Validation (main, per `session:appendChunk`)

- The session must exist, be active (`recording` or `stopping`) and be owned by the recorder `webContents` that created it (`FORBIDDEN` otherwise).
- `seq` must be exactly `lastSeq + 1`. Same `seq` as the last chunk with identical byte length and SHA-1 is acknowledged without writing again (idempotent). Any other already-written `seq`, or the same `seq` with different content, is `DUPLICATE_MISMATCH`. A jump is `SEQ_GAP`.
- Payload: `ArrayBuffer`/`Uint8Array`, 1 byte to 16 MB, otherwise `CHUNK_TOO_LARGE` / `INVALID_PAYLOAD`.
- Every rejection is logged with the session prefix, seq and code, never with content.

### 4.2 Backpressure

- The renderer's `ChunkUploader` sends one chunk at a time and waits for the acknowledgement, which main only sends after the bytes were written. Its queue is bounded (16 chunks / 64 MB); overflow stops the recorder with `QUEUE_OVERFLOW`, never dropping chunks silently and never buffering without bound.
- Main serializes every operation of a session through a promise chain, so concurrent invokes still write in order.
- High-water marks are kept in `manifest.stats`: `queueHighWaterChunks` and `queueHighWaterBytes` (renderer, sent with each append), `mainQueueHighWater` (operations waiting in main), `maxWriteMs` (slowest chunk write). Phase 09 benchmarks read them.

### 4.3 Disk pressure and write failures

- Free space of the volume that holds `userData` is read with `fs.statfs` before a recording starts and every 30 s while it runs.
- `< 1 GB` free: the recording does not start (`LOW_DISK`).
- `< 500 MB` free while recording: the recorder is stopped through the normal write-failed path (`DISK_LOW`), everything acknowledged so far is finalized and the result says the recording stopped early.
- `ENOSPC`/`EDQUOT` (`DISK_FULL`), `EIO`, `EACCES`, `EPERM` (`WRITE_FAILED`) on a chunk write: the session is marked `failed` with the error, the file handle is closed, the renderer's recorder is stopped, and `stream.webm` is kept for recovery. Finalization is still attempted on what was written.
- The remux needs roughly the stream's size on the output volume. It is refused with `LOW_DISK` when the output volume has less free than the stream plus a margin; `stream.webm` is kept.

## 5. Finalization

1. `stopping`: stop the recorder; the renderer flushes its last chunk and every acknowledgement, then calls `session:finish` (main verifies the last sequence number).
2. `stopped`: the file is fsynced and closed.
3. `finalizing`: the manifest records the output directory, final file name and partial path, then
   `ffmpeg -hide_banner -nostats -progress pipe:1 -y -i stream.webm -c copy -map 0 -f webm <outputDir>/.framecapt-<id>.partial.webm`.
4. The partial file is probed (`ffprobe -show_streams -show_format`): it must contain a video stream and a duration greater than 0.
5. It is renamed to the final name (`FrameCapt YYYY-MM-DD at HH.mm.ss.webm`, with ` (2)`, ` (3)` ... on a collision; an existing file is never overwritten). The final size is compared with the partial size.
6. Only then: manifest `completed` (with `outputPath`), `completed/<id>.json` written, session directory (including `stream.webm`) deleted.

If the remux or the probe fails: `stream.webm` is kept, the manifest becomes `failed` (`REMUX_FAILED`, ffmpeg stderr tail in `finalize.log`). If the raw stream itself probes with a video stream, it is copied to the output folder as a last resort and the result says honestly "Saved without a seeking index". The stream is kept in that case too (a raw copy is not a successful finalization), so the next start offers Recover again. Otherwise the user is told the data was kept for recovery.

`finalizing` that was interrupted (crash, kill, quit past the 15 s cap): on the next start the matching partial file is deleted and the remux runs again once. "Matching" means: the manifest's `finalize.partialPath` equals `<finalize.outputDir>/.framecapt-<manifest.sessionId>.partial.webm` and the directory name equals the manifest's `sessionId`. Nothing else is ever deleted from the output folder.

## 6. Recovery

On startup `recovery.ts` scans `<userData>/recordings/<uuid>/`:

- finalizing sessions are re-run automatically (5);
- `completed`/`recovered`/`discarded` leftovers are cleaned (only when the output exists / only for `discarded`);
- everything else with a non-empty `stream.webm` is a **candidate** (size, time, source kind, chunks, last state).

The Capture view shows one calm card per candidate: "We found an unfinished recording from <time> (<size>)" with **Recover** and **Discard**.

- **Recover** remuxes like a normal finalization (name `... (recovered).webm`), probes it and says "Recovered <duration> of video. Recovered what could be saved." only when a video stream with a duration greater than 0 exists. Otherwise: "This recording couldn't be repaired. The raw data was kept at <path> for diagnostics." with Reveal and Discard. Recovery is never described as lossless.
- **Discard** asks for confirmation, then deletes only that session directory, after verifying the id is a plain uuid, the directory lies inside `<userData>/recordings`, and it holds a manifest whose `sessionId` equals the directory name. User exports are never touched.

## 7. Quit during a recording

`before-quit` stops the recording and waits for finalization with a hard cap of 15 s. When the cap is exceeded the running ffmpeg process is killed, the app quits, and the manifest stays `stopping`/`finalizing` for the next start. The renderer is never asked to quit before the recorder had the chance to flush.

### 7.1 Compressed storage (post-processing)

With the setting `recording.storage = 'compressed'`, a saved single-source WebM is queued as a compress job (`CompressService`, on the shared `JobRunner`) after the session was finalized and added to history. The job writes `<name>.mp4` through a `.partial` file (libx264 medium, CRF 28, yuv420p, even scale, AAC 96 kbps, `+faststart`), probes it (H.264, audio kept, duration within 0.5 s), renames it, updates the history item in place (path, format, size; id, thumbnail and date kept) and only then moves the WebM to the Recycle Bin (`shell.trashItem`). Failure, cancel or quit leave the WebM and its history item unchanged and remove the partial file; quitting cancels the running job like a running MP4 export. The setting is read at save time and is not part of the session manifest; the recorder only gets an optional `compressed` option (video bitrate x 0.6), so older manifests parse unchanged. Sessions that are recovered are not compressed automatically.

## 8. Measured limits

Host: Windows 11 Pro 10.0.26300, AMD Ryzen 7 7700, 63 GB RAM, Electron 44.5.1, FFmpeg 9.0.2 essentials, userData volume with 242.7 GB free (`fs.statfs` works there: `bavail * bsize`). Evidence: `docs/evidence/phase06/ffmpeg-integration.json` (real ffmpeg, synthetic VP9 + Opus live stream cut at arbitrary points) and `docs/evidence/phase06/recovery-native.json` (real screen + system audio recordings, process tree killed).

### 8.1 Normal finalization (native, real 6 s recording, screen + loopback audio, 1080p preset)

- Container duration 6.039 s (`ffprobe format.duration` is a number, not N/A), 1 VP9 video + 1 Opus audio stream, 1,548,029 bytes, Cues present, `-ss 3` decodes with no error output, full decode clean.
- The session directory (and its `stream.webm`) is gone when the result appears; a `completed/<id>.json` record and exactly one file in the output folder remain; no partial file.
- From the Stop click to the "completed" state (engine flush, last acknowledgements, remux, probe, rename, session removal): 161-422 ms for the 6 s recordings of the phase 05 native runs.
- Remux itself is a stream copy: milliseconds for a few MB (the 5 s synthetic stream: 36 ms for ffmpeg alone).

### 8.2 Forced kill of a real recording (native, `taskkill /F /T` on the whole app, three moments)

| Killed after (recording time) | Recovered duration | Lost (kill time minus recovered) | Manifest at kill said     |
| ----------------------------- | ------------------ | -------------------------------- | ------------------------- |
| 2.304 s                       | 1.969 s            | 0.33 s                           | 0 bytes, 0 chunks (stale) |
| 3.702 s                       | 2.991 s            | 0.71 s                           | 0 bytes, 0 chunks (stale) |
| 5.006 s                       | 5.041 s            | about 0 (-0.04 s)                | 1,396,823 bytes, 5 chunks |

All three: the banner appeared on relaunch, Recover produced a file with 1 video (VP9, 1920x804) and 1 audio (Opus) stream, a seek index, a clean full decode and a clean seek near the end, and the session directory was removed afterwards. Mean audio level of the recovered files -35 to -37 dB (the tone was captured).

What this shows, and what it does not:

- **Expected loss: up to about one MediaRecorder timeslice (1 s) of media plus the chunk that was in flight.** The recorder emits data once per second, so media that had not been handed to the uploader when the process died is gone; the remux also drops a last cluster that was cut off. Measured worst case in these three runs: 0.71 s. Three runs are a sample, not a guarantee.
- **The manifest is not trusted for sizes.** It is rewritten every 5 s or 10 chunks, so after an early kill it said 0 bytes while the file held 580-710 KB; recovery uses the real file size and probes the remuxed result.
- Killing the process is not a power cut. `stream.webm` is fsynced once, when the session stops, not after every chunk. After a process kill the OS still has every completed `write`, but after a power loss or OS crash data still in the OS write cache can be missing (the file may then end in the middle of a cluster, which the remux handles as below, or be shorter than the manifest says). Not tested: no power cut on this host.

### 8.3 Truncated streams (real ffmpeg, 5 s VP9 + Opus live stream, 10 chunks of arbitrary size)

| Cut at (of the bytes)                                  | Recovered duration | Decode                                  |
| ------------------------------------------------------ | ------------------ | --------------------------------------- |
| 0.1 % (inside the EBML/Tracks header, about 180 bytes) | not recoverable    | the card says so, raw data and log kept |
| 10 %                                                   | 0.081 s            | clean                                   |
| 30 %                                                   | 1.341 s            | clean                                   |
| 60 %                                                   | 3.166 s            | clean                                   |
| 90 %                                                   | 4.421 s            | clean                                   |

A stream cut inside a block or cluster is repaired up to the last complete cluster; the cut part is dropped and the file decodes cleanly. A stream cut inside the header (before Tracks) has no usable video and ffmpeg fails: reported as "couldn't be repaired", never as recovered. A file that is not WebM at all behaves the same.

### 8.4 Not covered / known limitations

- **Power loss / OS crash**: not tested (see 8.2).
- **Audio/video alignment after recovery** was not measured separately beyond a clean decode; the remux copies timestamps unchanged.
- **App crash during the remux itself**: with `taskkill /T` (and on quit past the cap) ffmpeg dies with the app and the next start re-runs the remux. If only the main process died and an orphaned ffmpeg is still writing the partial file, Windows refuses to delete the open file; that session then stays `finalizing`/`failed` and is offered as a candidate (not tested with a real orphan).
- **Disk full on the real disk** and **permission errors on a real folder** are tested with injected errors (ENOSPC/EIO/EACCES at the file layer, and a fake free-space value in the E2E build), not by filling the disk. The 30 s disk polling interval can overshoot the 500 MB limit by roughly 3.75 MB/s * 30 s at the highest bitrate.
- **Window/source loss**, **mic unplug** and similar sources of an early stop are unchanged from phase 05 (engine-reported events); they end in the same finalization path.
- Recovery needs ffmpeg: if it is missing, Recover reports it and keeps the data.
- The recovered file is probed (video stream, duration > 0) in the app; it is not fully decoded there (the tests decode it).

## 9. Verification

Unit and integration (`npm test`, including the real-ffmpeg tests, skipped with a message when `vendor/ffmpeg` is absent), `npm run test:e2e` (banner, Recover/Discard, quit cap and resume, low-disk start refusal and stop, normal finalization probes) and `npm run test:native` (normal recording probes, forced kill and recovery on the real host). The packaged app was started once from `out/FrameCapt-win32-x64/FrameCapt.exe`; its `main.log` showed `ffmpeg ok ffmpeg version 9.0.2-essentials_build-www.gyan.dev ...` (the packaged path `resources/ffmpeg/win32-x64` resolves).
