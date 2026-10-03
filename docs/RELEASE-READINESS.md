# Release readiness — FrameCapt 0.1.0

Date: 2026-10-03 · Branch `main` (local only, never pushed) · Lead: final validation (phase 12).

> **Rename note (2026-10-03):** the product was renamed from the working name Framelet to FrameCapt. Evidence files under `docs/evidence/` recorded before 2026-10-03 use the old name and are kept as recorded; artifacts named `Framelet-*` in that evidence correspond to `FrameCapt-*` in current builds.

## Verdict

**Working local beta on the build host.** Capture, editing, recording, file saving, export, recovery and the **installed** application were all exercised on real hardware: one interactive Windows 11 PC with two monitors. Unit tests alone were never treated as proof.

**Not ready for public release or sale.** The installer is **unsigned**, and owner actions remain open: name/trademark, app identity, signing certificate, contacts, payment provider, FFmpeg source mirroring, codec/patent and legal review. See [Owner actions](#owner-actions-prioritized).

## Delivered features

- **Screenshots** of a screen, a window (frame included) or a region (one monitor per selection). Screen and region captures are pixel-exact: full-size `desktopCapturer` images, with the size checked against each display. Window screenshots use a video frame. Output is PNG or JPEG via save dialogs that main owns, or the clipboard (Chromium's encoder path).
- **Editor**: crop, arrow, rectangle, text and solid opaque redaction, with undo/redo and pan/zoom. All edits are stored in image coordinates.
  - Redactions are drawn last and flattened into the PNG, JPEG, clipboard and history thumbnail output.
  - For JPEG, redactions are padded out to the compression block grid.
- **Recording** of a screen, a window or a region, at 1080p (fit) or source resolution and 30 or 60 fps.
  - Microphone and Windows system audio are optional and mixed into one track, with no monitoring.
  - Pause/resume, a countdown, and a floating toolbar with timer, mute and level meters. The toolbar is excluded from capture through content protection, verified on this host.
- **Disk-backed sessions** with sequenced, acknowledged chunk IPC and a bounded queue.
  - On stop, FFmpeg remuxes the session (`-c copy`, monotonic timestamps) into a seekable WebM, which is then published atomically.
  - Disk-space guards stop recording safely when space runs low.
  - Recovery after a crash or forced kill is best effort and stated honestly.
- **MP4 export** (H.264 + AAC, fast start) with progress, cancel and a timeout; the original is never touched. Bundled FFmpeg 9.0.2 essentials, SHA-256 pinned.
- **History**: local JSON store and thumbnails. Missing or moved files can be re-linked. "Remove from history" and "Delete file" (to the Recycle Bin, with confirmation) are separate actions.
- **Desktop integration**: versioned settings with corruption repair, configurable global shortcuts with conflict detection, tray, close-to-tray, opt-in launch at login, light/dark theme, keyboard-accessible UI (axe: 0 serious/critical issues), and a help dialog.
- **Security**:
  - Electron sandbox, context isolation and fuses (including `GrantFileProtocolExtraPrivileges` off); the UI is served from `app://framecapt`.
  - Strict zod IPC with role and origin checks; strict CSP; a network blocker; no telemetry; zero network traffic measured.
- **Packaging and docs**: Squirrel per-user installer and portable zip, CI and draft-release workflows (files only), and an update adapter that is safely unconfigured. GPL-3.0 license, third-party notices, user/build/testing docs and the commercial plan are included.

**Explicitly deferred** (per the project contract): cloud upload/sync, accounts, AI, OCR, webcam overlay, timeline editor, streaming, team features, billing integration, macOS/Linux, a native capture backend.

## Commands

```
npm ci                    # clean install from package-lock.json
npm run fetch:ffmpeg      # pinned FFmpeg (also run automatically by start/package/make)
npm start                 # development run
npm run lint && npm run typecheck && npm test
npm run test:e2e          # Playwright + Electron, mock-capture build
npm run test:native       # real capture on an interactive Windows desktop
npm run bench:recording   # DURATION_MIN=30 default; real 1080p30 recording benchmark
npm run make              # out/make: Squirrel installer + portable zip (UNSIGNED unless cert env set)
npm run smoke:packaged    # checks the packaged exe
npm run smoke:installed   # silent install → real capture/record/export → uninstall (modifies the user profile temporarily; backs up/restores)
```

Install: run `FrameCapt-Setup-0.1.0.exe` (per-user, `%LOCALAPPDATA%\FrameCapt`; SmartScreen warns because it is unsigned). Uninstall: Windows Settings → Apps, or `%LOCALAPPDATA%\FrameCapt\Update.exe --uninstall`.

## Verified environment

| Item      | Value                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| OS        | Windows 11 Pro 10.0.26300 x64                                                 |
| CPU / RAM | AMD Ryzen 7 7700 (8C/16T) / 63 GB                                             |
| Displays  | 3440×1440 primary at (0,0) + 2560×1440 at (3440,0), both scale 1, no rotation |
| Runtime   | Electron 44.5.1 (Chromium 152, Node 24.21); build Node 24.15 / npm 11.12      |
| FFmpeg    | 9.0.2 essentials (Gyan), SHA-256 `60f46726…52ba` of the release zip           |

Not available, so never verified: Windows 10, arm64, mixed-DPI, negative-origin or rotated displays (these are covered by unit tests only), screen readers, a signed build.

## Final validation run (2026-10-03, commit after phase 11 + phase 12 fixes)

| Check                                                         | Result                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`, `npm run typecheck`, `npx prettier --check .` | PASS                                                                                                                                                       |
| `npm test` (unit + real-FFmpeg integration)                   | PASS 762/762                                                                                                                                               |
| `npm run test:e2e`                                            | PASS 152/152. One known Playwright _worker_ crash (0xC0000409 during launch, see [testing.md](testing.md)) was retried by `scripts/run-e2e.mjs` and passed |
| `npm run test:native` (real capture on this host)             | PASS 46/46                                                                                                                                                 |
| `npm run make`                                                | PASS (log: UNSIGNED)                                                                                                                                       |
| `npm run smoke:packaged`                                      | PASS                                                                                                                                                       |
| `npm run smoke:installed`                                     | PASS, all checks ([evidence](evidence/phase10/installed-smoke.json))                                                                                       |
| Clean clone → `npm ci` → lint/typecheck/test                  | PASS ([Clean-clone check](#clean-clone-check))                                                                                                             |

## Artifacts (UNSIGNED; `Get-AuthenticodeSignature` = NotSigned; FrameCapt build with owner logo, 2026-10-03, `smoke:installed` 47/47 PASS)

| File                                                       | Bytes       | SHA-256                                                            |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `out/make/squirrel.windows/x64/FrameCapt-Setup-0.1.0.exe`  | 229,965,312 | `75def59a566a751113b7338b6dd4dfe59b4dfca7d0a044d78c59658eadd799e9` |
| `out/make/squirrel.windows/x64/FrameCapt-0.1.0-full.nupkg` | 228,766,988 | `60baf7eb564584ce3c361a369f45371e09107a16c12dac49507642bec9fd3f84` |
| `out/make/squirrel.windows/x64/RELEASES`                   | 80          | `0382926b5bcc4da62666d97a52b580875f3e4793dc6f279a903d360a04df4616` |
| `out/make/zip/win32/x64/FrameCapt-win32-x64-0.1.0.zip`     | 236,328,401 | `7cc2e5f9e57f5a7e678ec29dce52e0f2f8570df9f22f5de7eca9c54a2f235c90` |

Builds are not bit-for-bit reproducible; publish the checksums of the files you actually release ([evidence/phase10/artifacts.json](evidence/phase10/artifacts.json)).

## Acceptance checklist

Legend:

- **PASS:** exercised, with evidence.
- **BLOCKED:** cannot be done on this host or by the build.
- **NATIVE:** run on real Windows hardware.
- **SIM:** simulated, mocked or injected.

### Build and distribution

| Item                                                                     | Status         | Evidence                                                                                                                                                          |
| ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean install with the lockfile; lint, typecheck and meaningful tests    | PASS           | Clean clone below; 762 unit, 152 e2e and 46 native tests                                                                                                          |
| App starts from source and from the packaged Windows install             | PASS (NATIVE)  | e2e launches; `smoke:packaged`; `smoke:installed`                                                                                                                 |
| Install, launch, uninstall; user captures preserved on uninstall         | PASS (NATIVE)  | installed-smoke: sentinels and captures in Pictures, Videos and AppData survive; Squirrel leaves its 3.8 MB stub (documented)                                     |
| Production preload, resources, FFmpeg and renderer assets resolve        | PASS (NATIVE)  | installed app logs `ffmpeg ok 9.0.2`, UI loads from app://framecapt, `LICENSE`/`THIRD_PARTY_NOTICES.md` present                                                   |
| Update checks inactive without configuration; configured path documented | PASS / BLOCKED | state `unconfigured`, no autoUpdater calls, 0 network requests; a real feed cannot be tested until the owner hosts one ([release-process.md](release-process.md)) |

### Screenshot

| Item                                                           | Status                                                                                             | Evidence                                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full screen, window and region at the correct pixel resolution | PASS (NATIVE)                                                                                      | Exact physical size on both displays; region 400×300 exact with tolerance-0 edge pixels; window 640×400 content → 642×432 with frame               |
| Two monitors incl. negative origin and mixed DPI; rotation     | PASS for two scale-1 monitors (NATIVE); negative origin, mixed DPI and rotation BLOCKED (hardware) | Covered by geometry unit tests and a mock e2e layout at scale 1.5 / x = -2293                                                                      |
| Escape/cancel restores focus and leaves no overlay             | PASS (NATIVE + e2e)                                                                                | Window count returns to baseline, no session created; real OS-input Ctrl+Shift+3 then Esc                                                          |
| Arrows, text, boxes, crop and undo/redo survive zoom           | PASS (e2e)                                                                                         | Editor e2e checks export sizes at different zoom levels and DPR 1.5                                                                                |
| Opaque redaction flattened in PNG, JPEG and clipboard          | PASS (e2e, Chromium encoders)                                                                      | 0 non-black pixels under the redaction in PNG and clipboard; JPEG max channel 0 (block-padded)                                                     |
| No unredacted preview or history leak after a redacted save    | PASS (unit + e2e)                                                                                  | History thumbnails come only from the editor's flattened output; the original stays in an app-owned session that is deleted when the editor closes |

### Video and audio

| Item                                                                          | Status                                                        | Evidence                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen, window and region; screen/region on each monitor                      | PASS (NATIVE)                                                 | Primary screen, a region on the second display, a window fixture; screenshots on both displays                                                                               |
| Mic only, system only, both, neither; mute/unmute; device disconnect          | PASS for modes and mute (NATIVE + e2e); device disconnect SIM | The real mic signal was quiet in this room (stream present); unplugging was simulated by an injected engine event                                                            |
| Source closure, permission denial, no audio track, rapid commands             | PASS (NATIVE)                                                 | Closing the source window ended the recording in 375 ms with a playable file; mic-denied choice; 1 start accepted / 9 BUSY; 20 concurrent stops → 1 file                     |
| Pause/resume timeline and A/V sync                                            | PASS (NATIVE)                                                 | File length 6.10 s = active time with a 2 s pause excluded; A/V length difference 0.02 s                                                                                     |
| Stop is idempotent; no leaked tracks, windows or child processes              | PASS (NATIVE + unit)                                          | Resource counters 0 after every path; no ffmpeg or electron processes left                                                                                                   |
| 30-minute 1080p/30 fps recording, measured memory, CPU and A/V sync           | PASS (NATIVE)                                                 | 1800.6 s, 29.72 fps, drift +10.4 ms, process-tree CPU averaged 73.7 % of one core, working set +32 MB (plateau), queue high-water 1 chunk ([performance.md](performance.md)) |
| WebM and MP4 probe and play; conversion cancel/failure preserves the original | PASS (NATIVE)                                                 | ffprobe + clean decode; cancel at 38 % → original SHA unchanged, no partial file                                                                                             |
| No accidental recording of the selection overlay or controls                  | PASS (NATIVE)                                                 | 0 toolbar pixels in the recording vs 460 in the unprotected control; the overlay closes before recording starts                                                              |

### Reliability and security

| Item                                                                                  | Status                                                                                                                         | Evidence                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded recorder queue; disk-full and write failure handled                           | PASS for the queue (NATIVE high-water 1); disk-full/write failure SIM; real disk-full BLOCKED (needs an elevated small volume) | Injected-filesystem unit tests, e2e disk-pressure tests                                                                                                                |
| Forced termination at the capture and finalization stages; recovery limits documented | PASS (NATIVE)                                                                                                                  | Killed after 2.3, 3.7 and 5.0 s → recovered 1.97, 2.99 and 5.04 s; kill during remux ×3 → resumed and completed ([recording-persistence.md](recording-persistence.md)) |
| Path validation, IPC sender/payload validation, unauthorized requests rejected        | PASS (unit + e2e + packaged smoke)                                                                                             | Strict schemas, 68 channels audited, protocol traversal tests ([security-review.md](security-review.md))                                                               |
| FFmpeg runs without shell interpolation; dependencies and attributions checked        | PASS                                                                                                                           | `shell:false` argument arrays; `THIRD_PARTY_NOTICES.md`; `npm audit` 0                                                                                                 |
| No unsolicited network traffic or uploads; diagnostics omit capture content           | PASS (NATIVE)                                                                                                                  | 0 non-loopback TCP over 60 s (installed); logs redact paths and contain no titles or content                                                                           |
| Settings corruption and missing history files handled without losing recordings       | PASS (e2e)                                                                                                                     | Corrupt file set aside, defaults used, toast shown; missing-file state with re-link; user files never touched                                                          |

### Commercial and public release

| Item                                                                      | Status                                            | Evidence                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Canonical project license and dependency notices                          | PASS                                              | `LICENSE` (gnu.org text), `THIRD_PARTY_NOTICES.md`, both shipped inside the package                                    |
| Exact bundled FFmpeg licensing and source obligations recorded            | PASS (recorded); source mirroring BLOCKED (owner) | [ffmpeg.md](ffmpeg.md), [licensing.md](licensing.md)                                                                   |
| Working name, branding and release identity resolved by owner             | BLOCKED (owner)                                   | Provisional name `FrameCapt` and app id `com.framecapt.app`                                                            |
| Certificates, accounts and payment eligibility resolved; no fake checkout | BLOCKED (owner); no fake checkout PASS            | Provider research only; nothing created ([checkout-integration-requirements.md](checkout-integration-requirements.md)) |
| Paid-offer terms state update/support scope and open-source rights        | PASS (draft for owner review)                     | [commercial-plan.md](commercial-plan.md)                                                                               |
| All blockers shown prominently here                                       | PASS                                              | This document                                                                                                          |

## Security, licensing, signing, payment and release status

- **Security:** 13 findings fixed with regression tests. Remaining residual risks are documented in [security-review.md](security-review.md) §8; the former fuse risk is now closed. No known critical or high issues.
- **Licensing:** GPL-3.0-only. There are no incompatible npm dependencies; the Inter font (OFL-1.1) is flagged for owner review, and the Squirrel stub components are not yet inventoried.
- **Signing:** UNSIGNED. The wiring exists (environment variables and CI secrets) but has never been exercised.
- **Payment:** no provider has been selected and no checkout exists. Lemon Squeezy and Gumroad document payouts for Bangladesh sellers; Stripe does not support Bangladesh.
- **Release:** nothing has been published or pushed. `release.yml` creates drafts only and has never run on GitHub.

## Known issues, performance and recovery limits

- **Playwright worker crash:** about 1 in 6 full e2e runs, during Electron launch, with no product cause found. Mitigated by retrying only that exact crash signature, plus orphan cleanup in global teardown ([testing.md](testing.md)).
- **Frame pacing under motion:** about 0.9 % of frames fall below exact 30 fps. Static scenes are exactly 30.001 fps.
- **Short and real-mic cases:** recordings under about 100 ms may be saved without a seek index. The real microphone signal was not demonstrated loud (manual speaking test pending).
- **Window screenshots** include the window frame and come from a video frame (4:2:0), so they are not pixel-exact like screen and region captures. Minimized windows are not listed by Windows' capturer, and DRM content captures black.
- **Recovery:** best effort. A forced kill loses up to about 0.7 s, and a power loss may lose more (there is no fsync per chunk). A cut inside the WebM header cannot be recovered.
- **Performance thresholds:** all 19 PASS; see [performance.md](performance.md). Idle CPU is about 0.04 % of the machine.
- **Shortcut conflicts:** Ctrl+Shift+0 may collide with IME hotkeys on some systems; conflicts are detected and shown in the UI.

## Owner actions, prioritized

Full list with context: [OWNER-TASKS.md](OWNER-TASKS.md).

**Blocks a private beta (give the build to testers):**

1. Decide whether testers may run an unsigned build (SmartScreen warning), or get a signing certificate first.
2. Have one tester do a manual pass with a real microphone and on Windows 10.

**Blocks a public release (free download):** 3. Name/trademark clearance and final app identity (id, publisher, icon). This must be settled before the first release, because changing it later breaks upgrades. 4. Code-signing certificate, plus a signed-build install test. 5. Security, Code of Conduct and privacy contacts (currently placeholders). 6. FFmpeg corresponding-source mirroring (or a written offer) for every binary release; inventory the Squirrel stub licenses; decide on the OFL font. 7. Repository host, secrets, actions pinned to SHAs; an update feed if auto-updates are wanted.

**Blocks paid sales:** 8. Payment provider application (Lemon Squeezy or Gumroad are the documented options for Bangladesh), terms, refund policy and tax questions. 9. Codec/patent review for H.264/AAC (MP4 export can be disabled if needed). 10. Support mailbox and scope; real marketing screenshots.

## Clean-clone check

2026-10-03: `git clone` of `main` into a scratch folder → `npm ci` (0 vulnerabilities) → `npm run lint` exit 0 → `npm run typecheck` exit 0 → `npm test`: 744 passed and 18 skipped. The skipped ones are the real-FFmpeg integration tests, which skip with a message until `npm run fetch:ffmpeg` has run; in the main working copy, with FFmpeg fetched, all 762 pass. **PASS.**
