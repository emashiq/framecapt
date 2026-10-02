# Framelet — Agent Progress

Plan: `C:\Users\emash\.claude\plans\you-are-a-principal-snuggly-teapot.md` (lead: Opus; implementers: `.claude/agents/framelet-impl-{medium,low}.md` on Sonnet).
Branch: `main` (local only, one commit per verified phase, never pushed).
Statuses: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED, BLOCKED.

## Host
Windows 11 Pro 10.0.26300 · AMD Ryzen 7 7700 · 63 GB RAM · 2 monitors (2560 wide, 3440 wide) · Node 24.15.0 · npm 11.12.1 · FFmpeg 8.1.1 full_build (Gyan, PATH — verification tooling only).
User approved native tests on this host: real capture, 30-min benchmark, silent install/uninstall.

## Phase status
| Phase | Status | Notes |
|---|---|---|
| 00 Setup | VERIFIED | branch renamed master→main; agent defs; .gitignore |
| 01 Foundation | VERIFIED | Forge 8 + Vite 8 + React 19 + TS 6; secure bridge; e2e 9/9 on host |
| 02 Capture feasibility | VERIFIED | native 11/11 on host; exact-res screenshots both monitors; loopback audio captured |
| 03 Selection & screenshots | VERIFIED | native 18/18; region inset exact on both displays; e2e 28/28 |
| 04 Screenshot editor | VERIFIED | editor + pixel-exact capture; redaction pixels verified PNG/JPEG/clipboard |
| 05 Recording & audio | VERIFIED | native 29/29; ~30 fps all modes; toolbar excluded from capture |
| 06 Storage & recovery | VERIFIED | FFmpeg 9.0.2 bundled (SHA-pinned); remux finalize; forced-kill recovery verified natively |
| 07 Export & history | VERIFIED | MP4 export (libx264/aac, faststart) with cancel; history with trash-delete, relink |
| 08 Desktop polish | VERIFIED | settings/shortcuts/tray; axe 0 serious; idle CPU 0.04 %; flakes root-caused |
| 09 Security/reliability/perf | VERIFIED | 13 findings fixed; 30-min 1080p30 bench PASS (29.72 fps, drift +10 ms); lead audit agreed |
| 10 Packaging/CI/updates | VERIFIED | Squirrel installer (UNSIGNED) installed/captured/uninstalled on host; app:// scheme, fuse off; CI files |
| 11 Open source & sales prep | VERIFIED | canonical GPLv3, notices (53 deps, no incompatibility), user/build docs, commercial plan, provider research (none selected) |
| 12 Final validation | NOT_STARTED | |

## Phase log
<!-- Each phase: files changed, decisions, commands + results, evidence, risks, next step. -->

### Phase 01 — Foundation (VERIFIED 2026-10-02)
- Files: package.json/lock, forge.config.ts, vite.*.config.ts, tsconfig.*, eslint/prettier/vitest/playwright configs, src/{main,preload,shared,renderer}, tests/unit (5 files), tests/e2e/launch.spec.ts, docs/{architecture,decisions,capability-matrix}.md.
- Versions: electron 44.5.1 (Chromium 152, Node 24.21), forge 8.0.1, vite 8.3.2, react 19.3.0, typescript 6.0.3, tailwind 4.3.3, zod 4.6.5, vitest 5.0.3, playwright 1.63.0, eslint 10.11.
- Decisions: single renderer entry with hash roles; role registry + origin + zod checks per IPC; CSP via header and build-injected meta; fuses enabled (e2e runs against .vite/build with node_modules electron because fuses disable inspect args); provisional app id com.framelet.app.
- Commands (lead re-ran): `npm run lint` exit 0; `npm run typecheck` exit 0; `npm test` 31/31. Implementer: `npm ci` ok; `npm run test:e2e` 9/9; `npm run package` → out/Framelet-win32-x64/Framelet.exe launched (4 processes) and killed.
- Risks: electron binary downloads lazily on first require after npm ci; `npm run make`/Squirrel not yet exercised (phase 10).
- Next: phase 02.

### Phase 02 — Capture feasibility (VERIFIED 2026-10-02)
- Files: src/main/capture/* (provider boundary, Electron + gated mock provider, one-shot grants, display-media handler, diagnostics save), src/renderer/capture/* (stream, frame, audio graph, region crop, format probe, resource counters), diagnostics view, tests/native/capture.native.spec.ts, playwright.native.config.ts, scripts/check-no-mocks.mjs, docs/capture-feasibility.md.
- Host displays: 3440x1440 (primary) + 2560x1440, both scale 1 (mixed-DPI/rotation/negative origin not physically available → covered by unit tests only).
- Results (native): screenshots exact physical size on both displays; system loopback + test tone 4 s → VP9 3440x1440 + Opus, mean −38 dB; region 1280x720 canvas+timer 29.8 fps, SSIM 0.98 vs 0.25 control; mic stream recorded; no-grant/bogus-source/camera requests denied; zero leaked tracks/contexts/timers.
- Decisions: default `video/webm;codecs=vp9,opus`; frame grab via track processor with <video> fallback; frame size taken from decoded frame (track.getSettings unreliable pre-first-frame); canvas+timer crop for region video.
- Commands (lead re-ran): lint 0, typecheck 0, `npm test` 61/61. Implementer: test:e2e 11/11 (incl. check:mocks), test:native 11/11.
- Lead fix: redacted Windows username from evidence JSON; evidence dir excluded from prettier. Media evidence is gitignored (contains real desktop content).
- Risks: system-audio-unavailable path untested natively; window-source capture & hidden-window throttling untested (phase 03/05).

### Phase 03 — Selection & screenshots (VERIFIED 2026-10-02)
- Files: src/shared/{geometry,selection,shots,shot-ipc}.ts; src/main/{worker,overlay,capture-flow,shot-handlers,events}.ts, src/main/shots/*; renderer overlay views, SourcePicker, ResultView, RecorderWorker, use-capture-flow; scripts/{package-e2e,clean-build}.mjs; tests unit/e2e/native.
- Results: lint/typecheck 0; unit 129/129 (lead re-ran); e2e 28/28; native 18/18. Screen pick dims exact on both displays; 400x300 region exact, +20 px expansion inset exactly 20 px on both displays; overlay/dim/pill never in output; cancel leaves window count at baseline and no session; window capture includes frame (640x400 content → 642x432).
- Findings: getDisplayMedia frames are 4:2:0 (≈1 px chroma bleed on saturated edges); full-size desktopCapturer thumbnail is pixel-exact (~400 ms). Electron 44 clipboard is promise-based (ClipboardItem image/png). Minimized windows are not listed by desktopCapturer.
- Lead decision: switch screen/region screenshots to full-size desktopCapturer images (pixel-exact, dims verified) in phase 04 work item 0; keep getDisplayMedia for recording.
- Risks: mixed DPI/negative origins/rotation unit-tested only (host is 2× scale-1); overlay interaction natively driven by Playwright events, not OS input; click→region overlay 1.95 s (target <0.8 s after the switch).

### Phase 04 — Screenshot editor (VERIFIED 2026-10-02)
- Files: src/renderer/editor/* (pure model, history, hit-test, view math, flatten), src/renderer/views/editor/*, src/main/capture/exact-capture.ts, src/main/close-guard.ts, src/shared/pixels.ts, AlertConfirm; tests unit (model/flatten with @napi-rs/canvas/view/close-guard/pixels), e2e editor.spec.ts.
- Screenshot source switched to full-size desktopCapturer (dims verified per display; worker fallback). Magenta edge test exact with tolerance 0 (160 probes). Region click→overlay median 0.70 s (0.68–0.79) via hidden pre-created overlays + raw BGRA frame transfer. Window screenshots still use video frame (thumbnail 642x430 ≠ frame 642x432).
- Redaction: solid #000 drawn last, +1 px; JPEG redactions padded to 16 px block grid (+2 px) because JPEG ringing leaked up to 24/255 near edges (ADR-016). Chromium-path checks: PNG 0 non-black, clipboard 0, JPEG max channel 0 under redaction.
- Results: lint/typecheck 0; unit 188/188 (lead re-ran); e2e 45/45; native 18/18. Idle 0 rAF; drag p95 16.8 ms at 2560x1440.
- Risks: one first-run e2e region-drag flake (launch race) — revisit in phase 08/09; mixed-DPI untested physically; session-end hook untested.

### Phase 05 — Recording & audio (VERIFIED 2026-10-02)
- Files: src/shared/{recorder-machine,recorder-ipc}.ts, src/main/recorder/controller.ts, src/main/recording/{session-service,media-protocol}.ts, src/renderer/recorder/{engine,chunk-uploader}.ts, toolbar/countdown/choice/result views, tests (unit table+random state machine, e2e recording.spec.ts, native recording.native.spec.ts).
- Native results (VP9/Opus WebM): no-audio 1920x804 29.7 fps; system+tone with 2 s pause → file 6.10 s = active time (pause excluded), A/V length diff 0.02 s; mic only; mic+system mixed into one Opus track; region 1280x720 on second display; source preset 3440x1440; window fixture 642x432. Hidden recorder window ~30 fps (backgroundThrottling false). Toolbar exclusion via setContentProtection: 0 red pixels in recording vs 460 in unprotected control.
- Results: lint/typecheck 0; unit 318/318 (lead re-ran); e2e 70/70; native 29/29.
- Open (→ phase 06): no duration/cues until remux; session dir duplicates output; no recovery/disk checks; quit-cap & forced-kill untested. Real mic signal was silent in room (stream present) — manual speaking test pending. Mic unplug / missing loopback not physically exercised.

### Phase 06 — Storage & recovery (VERIFIED 2026-10-02)
- Files: scripts/fetch-ffmpeg.mjs (Gyan 9.0.2 essentials, SHA-256 60f46726…, idempotent; npm pre-hooks), src/main/media/ffmpeg.ts, src/main/recording/{manifest,session-fs,finalize,recovery,recovery-handlers,session-service}.ts, src/main/recorder/quit-cap.ts, RecoveryBanner, docs/{recording-persistence,ffmpeg}.md, tests (unit + real-ffmpeg integration, e2e recovery.spec.ts, native recovery.native.spec.ts).
- Behaviour: chunks appended in sequence to one stream.webm; finalize = ffmpeg -c copy remux → probe → atomic publish → session dir deleted (completed/<id>.json kept). Owner-bound sessions, SHA-1 idempotent duplicates, disk checks (start <1 GB refuse; <500 MB stop safely), quit cap 15 s → resume finalization next start.
- Native: 6 s recording format.duration 6.039 s with cues, -ss 3 decodes. Forced kill after 2.3/3.7/5.0 s → recovered 1.97/2.99/5.04 s, video+audio, clean decode. Packaged exe logged "ffmpeg ok 9.0.2".
- Results: lint/typecheck 0; unit 407/407 (lead re-ran); e2e 76/76; native 31/31. E2E-only env hooks gated by __FRAMELET_E2E__ (lead reviewed) and listed in check-no-mocks.
- Risks: per-chunk fsync not done (OS crash may lose cached data); orphaned ffmpeg after main death untested; real disk-full only simulated; sub-100 ms recordings saved raw; FFmpeg adds ~211 MB; GPL source offer = owner task.

### Phase 07 — Export & history (VERIFIED 2026-10-02)
- Files: src/main/media/export.ts, src/main/history/* (store, thumbs, query, service, export-service, handlers), src/shared/history-ipc.ts, renderer history views, Mp4Export, RecentCaptures; tests unit/e2e/native.
- Native: real 6.07 s recording → MP4 in 0.89 s, h264 yuv420p + aac, Δduration 0.005 s, moov before mdat, clean decode, original SHA unchanged. Cancel at 38 % → original intact, no .partial, no ffmpeg left; retry OK. Corrupt input/unwritable dest/truncated source → typed errors, nothing published.
- History: zod JSON store with corruption set-aside, 1000 cap, 200 MB thumb cap, thumbnails from flattened editor output only, existence checks + relink, delete via shell.trashItem, undo remove, framelet-media thumb/file routes with nonce.
- Results: lint/typecheck 0; unit 491/491 (lead re-ran); e2e 101/101; native 33/33 (final run).
- Risks: native flakes seen once each (region drag 107x139; ffmpeg non-monotonic dts on seek decode) → phase 08; real Recycle Bin/shell windows stubbed; quit-during-export untested; H.264/AAC patent review = owner.

### Phase 08 — Desktop polish (VERIFIED 2026-10-02)
- Files: src/main/{desktop,shortcuts,actions,tray}.ts, src/main/settings/*, src/shared/{settings,shortcuts,error-messages}.ts, scripts/generate-tray-icons.mjs, settings/home/help UI, tests (e2e desktop/a11y/recording-timestamps, native desktop), docs/keyboard-shortcuts.md.
- Settings v1 (zod, atomic debounced, corruption set-aside, migration scaffold); global shortcuts with conflict status (native RegisterHotKey conflict detected); tray singleton; close-to-tray; quit-while-recording confirm; home rebalanced; toolbar sized to content (±1 px); focus/aria/skip link/contrast; help dialog.
- Root causes fixed: (1) region drag flake = buttonless synthetic pointermove from real mouse movement → ignored mid-gesture (4/4 fail → 8/8 pass); (2) 2/30 recordings had duplicate first timestamps → remux now uses setts bsf for strictly increasing timestamps; checks assert monotonic packets.
- Native: real SendInput Ctrl+Shift+3 → overlays → Esc OK; idle CPU total 0.041 % of the whole machine (= ~0.66 % of one core; corrected in phase 09 — Electron percentCPUUsage is machine-relative) over 30 s; affected native tests 5/5 stable.
- Results: lint/typecheck 0; unit 596/596 (lead re-ran); e2e 150/150 incl. axe (0 serious/critical, both themes); native 38/38.
- Risks: launch-at-login untested until installer (phase 10); screen reader untested; Ctrl+Shift+0 may collide with IME hotkeys on some systems.

### Phase 09 — Security, reliability & performance (VERIFIED 2026-10-02)
- Docs: docs/security-review.md (S-01..S-13 fixed with tests, 68-channel IPC table, residual R-01..R-09, lead independent review §12), docs/performance.md (19 thresholds from baseline, all PASS).
- Fixes: strict IPC schemas everywhere (S-01), ffmpeg protocol whitelist + absolute inputs (S-02), history:open media-only (S-03), no paths to toolbar/countdown/recorder (S-04), no window titles in manifests (S-05), home dir redacted in logs (S-06), no junction following (S-07), frame-navigation/device/spellcheck/network blocker/enableSandbox (S-08), media protocol hardening (S-09), worker frame cap, role alignment, check-no-mocks scans asar (S-10..12).
- 30-min bench (scripts/bench-recording.mjs, real capture, 1080p30, system audio, motion): 1800.59 s, 29.72 fps (53,511 frames), A/V drift +10.4 ms, CPU tree avg 73.7 % of one core (4.6 % machine), working set +32 MB min2→end (plateau ~min15), queue high-water 1 chunk, stop→completed 1.0 s. Optimization: capture constrained to preset size → GPU private memory 784→220 MB.
- Failure modes (native): source closure, mic denied, rapid commands, kill during remux ×3, unwritable output → all PASS; real disk-full BLOCKED (needs elevated small volume; injected tests cover).
- Lead fix: `@electron/get` re-fetched SHASUMS256.txt each package and GitHub's asset CDN timed out → pinned Electron zip SHA-256 (verified against official SHASUMS) in forge.config.ts `download.checksums`.
- Results: lint/typecheck 0; unit 719/719 (lead); e2e 150/150 (lead re-ran after checksum pin); native 46/46 (implementer); npm audit 0.
- Risks: R-01 GrantFileProtocolExtraPrivileges fuse on (→ phase 10 app:// scheme); ~0.9 % frames below exact 30 fps under motion; region/60 fps/mic not benchmarked at length.

### Phase 10 — Packaging, CI & updates (VERIFIED 2026-10-02)
- Files: forge.config.ts (identity PROVISIONAL, icon, win32metadata, env-only signing with UNSIGNED log, nuspec template w/o iconUrl, pinned Electron checksum, GrantFileProtocolExtraPrivileges fuse OFF), src/main/{app-asset,app-protocol,updates}.ts, assets/app/*, scripts/{smoke-installed,record-artifacts}.mjs, .github/workflows/{ci,release}.yml (draft-only, minimal permissions), docs/{packaging,release-process,testing}.md, tests (unit app-asset/app-protocol/squirrel/updates, e2e network.spec.ts).
- R-01 closed: production UI served from app://framelet with strict resolver (lead reviewed); all suites pass with the fuse off.
- Installed test (this host): silent install 6.0 s; installed exe fuse-verified, resources present, ffmpeg ok 9.0.2; real screenshot 3440x1440 PNG; real recording VP9 1920x804 7.5 s + MP4 auto-export h264; zero non-loopback TCP in 60 s; uninstall removes app/shortcuts/ARP/Run entry and keeps Pictures/Videos/AppData user files (sentinels verified). Squirrel leaves its ~3.8 MB stub (documented).
- Defects found & fixed via installed run: Squirrel iconUrl fetch stalled offline install 85 s; --squirrel-firstrun quit the app; launch-at-login args over-quoted (never started).
- Artifacts (UNSIGNED): Framelet-Setup-0.1.0.exe sha256 5fab53a2…246f (228,981,760 B); Framelet-0.1.0-full.nupkg ff3f4003…7e9a; zip 36ddda97…6984 — docs/evidence/phase10/artifacts.json.
- Results: lint/typecheck 0; unit 762/762 (lead re-ran); e2e 151 pass + 1 pre-existing Playwright worker crash flake (0xC0000409, reproduced on phase 09 commit 1/6); native 46/46; make, check:mocks, smoke:packaged, smoke:installed OK; workflows validated locally only. Evidence writing now gated by FRAMELET_WRITE_EVIDENCE=1.
- Risks: signing never exercised; workflows never run on GitHub; no update feed; Win10/arm64/upgrade/SmartScreen untested; e2e worker-crash flake (→ phase 12).

### Phase 11 — Open source & sales preparation (VERIFIED 2026-10-02, docs only)
- Files: LICENSE (canonical GPLv3 from gnu.org, 674 lines), THIRD_PARTY_NOTICES.md (53 prod deps: 50 MIT, ISC, 0BSD, OFL-1.1; FFmpeg 9.0.2 = n9.0.2 tag, source URL verified), README, CONTRIBUTING (no CLA), CODE_OF_CONDUCT (Contributor Covenant 2.1, contact placeholder), SECURITY/PRIVACY (placeholders, no invented contacts), CHANGELOG, .github issue/PR templates, docs/{user-guide,building-on-windows,licensing,commercial-plan,release-notes-0.1.0,product-copy,checkout-integration-requirements,OWNER-TASKS}.md.
- Commercial: $15 current major + 12 months updates, optional $29 supporter, no gating/keys, GPL rights preserved. Providers (official pages 2026-10-02): Stripe no BD; Lemon Squeezy & Gumroad list BD bank payouts; Paddle/FastSpring unverified → none selected.
- Checks: prettier --check . and lint pass (lead reviewed README for overstatements: none).
- Open (→ phase 12): package must ship Framelet LICENSE + THIRD_PARTY_NOTICES; OFL font & Squirrel stub notices flagged for owner review; README home screenshot shows a test-modified shortcut.

## Recovery instructions
If a session ends: read this file, `git log --oneline`, `git status`; resume at the first phase not VERIFIED using `capture-prompts/RESUME.md`.
