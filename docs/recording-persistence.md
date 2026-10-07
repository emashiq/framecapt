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

### 7.1 Save format and compression (post-processing)

Since ADR-049 the single setting below is two: `recording.saveFormat` (webm, mp4, mkv, gif) and `recording.compression` (off, light, balanced, strong). `FinalizeService` (src/main/history/finalize-service.ts, the old compress service generalized) runs after a saved single-source WebM; WebM + off does nothing. `convertArgs` (src/main/media/convert.ts) builds the ffmpeg arguments: MKV + off is `-map 0 -c copy`; MP4/MKV re-encode with libx264 medium (CRF 23/28/32, AAC 128/96/64 k; MP4 + off is CRF 20 veryfast, AAC 160 k); WebM with libvpx-vp9 `-b:v 0` (CRF 33/38/43, row-mt, good, cpu-used 4, Opus 96/64/48 k); GIF is `fps=12`, width at most 1280, `palettegen`/`paletteuse`, no audio, a recording over 60 s is skipped. `verifyConvert` checks the container, codecs, audio and length (GIF: 5 % or 0.6 s). The `.fcap` is never converted. The live recorder's bitrate factor is off/light 1.0, balanced 0.6, strong 0.45 (`recording.compression` option; the older boolean `compressed` still parses and means balanced). The rest of this section describes the original MP4-only job, whose verify-then-trash sequence still applies.

#### Original description (compressed storage)

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

## 10. Multi-source recordings and the `.fcap` container (2026-10-07)

Owner request: record several screens or windows together and keep them in a format that only FrameCapt plays, from which a source (or a part of the time) can be extracted. A single-source recording is unchanged (`.webm`, `.mp4`); only a recording of 2 to 4 sources becomes a `.fcap`.

### 10.1 What is recorded

- `recorder:start` takes `target: 'multi'` with `sources: [{ sourceId }]`, 2 to 4 entries, no duplicates, ids of the usual `screen:<n>:<n>` / `window:<n>:<n>` shape. The controller checks every source against a fresh `listSources` (screens and windows) before anything starts and again after the selection step (`SOURCE_MISSING`), opens no overlay, ignores follow-mouse, runs the countdown on the primary display and places the toolbar as usual.
- The engine acquires the display streams **one after the other** (a capture grant is one-shot per webContents). System audio is requested for the first source only; the microphone is as usual.
- One canvas, one MediaRecorder: every source is a tile of one picture (`createCompositor`). Screens only: layout `virtual`, each display at its physical position on the virtual desktop (`bounds * scaleFactor`, negative origins included). Any window among the sources: layout `grid` of equal cells, every tile fitted into its cell. A tile fits ("letterboxed") its cell at the size its source has **now**, so a window that is resized while recorded keeps its shape.
- The **whole** picture is capped (`mosaicLimit`): quality `1080p` allows at most 3840 x 2160 and 3840 x 1080 pixels; `source` allows at most 7680 across and 8.3 million pixels. Sides are even; nothing is upscaled. The video bitrate comes from the output size (`videoBitrate`, times 0.6 with compressed storage).
- A source that ends (screen unplugged, window closed) blanks its tile (a neutral "Source ended" tile), the engine sends `tileLost { index }`, main logs it and the toolbar shows a warning badge; the recording goes on. When **every** source has ended the recording stops as it does today (`sourceLost`).

### 10.2 Session and manifest

`manifest.source.kind` and `completed/<id>.json` `source.kind` accept `multi`, and the manifest gets an optional `layout: { width, height, sources: [{ name, kind, rect }] }`, so older manifests still parse. The names are generic (`Screen 1`, `Window 2`, by position): window titles are never written (security review S-05, extended in section 15). The rectangles are the tiles the engine reports in its `prepared` event.

### 10.3 Finalization

1. The usual remux of `stream.webm` (section 5), but into `remuxed.webm` **inside the session directory**, never the output folder.
2. A `.fcap` is written to `<outputDir>/.framecapt-<sessionId>.fcap.partial` (header, then the remuxed WebM copied in 1 MB pieces, flushed), checked (the header is parsed back against the file size) and renamed to a free `FrameCapt YYYY-MM-DD at HH.mm.ss.fcap` (` (2)`, ... on a collision, never overwritten).
3. The temporary WebM and the partial are removed on every path; then the session completes as in section 5 (record `completed/<id>.json` with the `.fcap` path, session directory deleted).

A failed remux of a multi-source session does **not** fall back to the raw copy of section 5 (a raw stream has no header and would be an orphan): the data is kept and Recover is offered. Not enough free space for the `.fcap` is `LOW_DISK`. The thumbnail is made by history from the `.fcap` payload through `mediaInputArgs` (10.5), not from a separate temporary file.

### 10.4 The `.fcap` format, version 1

All integers are little-endian. A file is exactly the header block (4096 bytes) followed by the payload.

| Bytes   | Content                                                                                 |
| ------- | --------------------------------------------------------------------------------------- |
| 0..4    | `46 43 41 50 00` = ASCII `FCAP` and a zero byte                                         |
| 5       | format version, `1`                                                                     |
| 6..7    | reserved, `00 00`                                                                       |
| 8..11   | `u32` length of the JSON header in bytes (1 .. 65536, and it must end before byte 4096) |
| 12 ..   | the JSON header, UTF-8                                                                  |
| ..4095  | zero padding                                                                            |
| 4096 .. | the payload: an ordinary WebM, `payloadLength` bytes                                    |

JSON header (strict: no other keys):

```json
{
  "version": 1,
  "width": 3840,
  "height": 1080,
  "durationMs": 12345,
  "hasAudio": true,
  "createdAt": 1760000000000,
  "sources": [
    {
      "name": "Screen 1",
      "kind": "screen",
      "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
    },
    {
      "name": "Window 2",
      "kind": "window",
      "rect": { "x": 1920, "y": 0, "width": 1920, "height": 1080 }
    }
  ],
  "payloadOffset": 4096,
  "payloadLength": 5000000,
  "payloadType": "video/webm"
}
```

`rect` is the source's tile in the recorded picture, in pixels. Window titles are never stored.

Reader rules (`src/main/recording/fcap.ts`, `parseFcapHeader`): wrong magic, a short file or a non-zero byte after the magic -> `NOT_FCAP`; a version other than 1 -> `UNSUPPORTED_VERSION`; a JSON length of 0 or above 64 KB or beyond byte 4096, non-zero reserved bytes, invalid JSON, any schema violation (types, extra keys, 1..4 sources, a source outside the picture, `payloadOffset != 4096`, another `payloadType`) -> `CORRUPT`; a header that needs more bytes than the file has, or a payload that ends past the end of the file -> `TRUNCATED`. Version 1 fixes the payload offset at 4096, so a reader needs no more than the first 4096 bytes. A future incompatible version gets a new version byte.

### 10.5 Reading it

- **Media protocol** (`media-protocol.ts`, `range.ts`): for a `.fcap` the protocol serves the **payload** only, as a file that starts at byte 0 and is `payloadLength` long, `Content-Type: video/webm`. `Range` requests are answered in payload coordinates (`planMediaSlice`: `206` with `Content-Range: bytes a-b/<payloadLength>`, suffix ranges count from the payload's end, `416` with `bytes */<payloadLength>`), read from the file at `offset + a`. The header is cached by path, size and modification time. A file with an invalid header is `404`.
- **ffmpeg** (`src/main/media/ffmpeg.ts`): `mediaInputArgs({ path, format })` is the one function that builds an input; for `fcap` it is `-protocol_whitelist file -skip_initial_bytes 4096 -f matroska -i <path>` (the same absolute-path and file-protocol rules as every other input). `-ss` before it seeks inside the payload. Used for the history thumbnail, `ffprobe` (the `format` option of `MediaTools.probe`), relinking and extracting. `tests/unit/fcap-integration.test.ts` runs the real ffmpeg: probe, `-ss` into the middle with a decoded frame that differs from the first one, a full decode without errors, a thumbnail and an extract. `skip_initial_bytes` and seeking work together, so no temporary payload file is needed.
- **Other players** cannot open the file (by design); "Open" in History shows the details view in FrameCapt instead of calling the shell.

### 10.6 Recovery, History, Extract

- An interrupted multi-source session (`manifest.layout` present) is finished the same way by startup recovery and by **Recover** (`... (recovered).fcap`); its partial file is `.framecapt-<id>.fcap.partial`, the only temporary name recovery deletes for such a session (the usual rule: the name must match the manifest's plan and carry the session id).
- History: `format: 'fcap'`, `source: 'multi'`. `HistoryItemView.layout` carries the picture size and the sources from the header (null when the header cannot be read: the card stays, the details view says the file cannot be read). Rescan reads the header instead of running ffprobe. MP4 export and compressed storage accept WebM only and skip an `.fcap`.
- **Extract** (`history:extractFcap { id, sourceIndex | null, startMs, endMs, format: 'mp4' | 'webm' }`, role `main`, strict): one `JobRunner` job (one ffmpeg job at a time, shared with exports; progress and cancel use the `export:*` events and `export:cancel`, kind `extract`). The ffmpeg arguments seek the payload, cut a length (`-ss` before the input, `-t`), crop the source's rectangle (`crop=w:h:x:y`) and make the sides even; MP4 is H.264 + AAC, WebM is VP9 + Opus. The output is `<name> - Screen 1.mp4` (`<name> - All.mp4` for the whole picture) next to the `.fcap`, written through a partial file, probed (container, codec, size, length within 0.6 s, audio kept) and renamed; it becomes a new history item with `derivedFrom` = the `.fcap`. The `.fcap` is only read.
- Hook for editing: `layoutSourceRect(layout, index)` (`src/shared/recording-layout.ts`) returns a source's crop rectangle; a later editor opens a source through it and `mediaInputArgs`.

### 10.7 Not covered

- Windows are captured as the OS delivers them (a minimized window may deliver nothing: its tile stays black until it returns); a window that is resized is letterboxed, not re-laid-out.
- Mixed-DPI screens are placed by `bounds * scaleFactor`; two displays whose physical edges differ by a pixel overlap by up to that pixel.
- The screenshot button of the toolbar takes a still of the **first** source only.
- No per-source audio: one mixed track (first source's system audio, microphone).
- Real capture of several screens/windows and a real unplugged source were not run in this change (native checks pending); the unit, real-ffmpeg and mock-capture E2E layers are covered.
