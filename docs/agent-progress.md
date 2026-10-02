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
| 06 Storage & recovery | NOT_STARTED | |
| 07 Export & history | NOT_STARTED | |
| 08 Desktop polish | NOT_STARTED | |
| 09 Security/reliability/perf | NOT_STARTED | |
| 10 Packaging/CI/updates | NOT_STARTED | |
| 11 Open source & sales prep | NOT_STARTED | |
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

## Recovery instructions
If a session ends: read this file, `git log --oneline`, `git status`; resume at the first phase not VERIFIED using `capture-prompts/RESUME.md`.
