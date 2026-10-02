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
| 03 Selection & screenshots | NOT_STARTED | |
| 04 Screenshot editor | NOT_STARTED | |
| 05 Recording & audio | NOT_STARTED | |
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

## Recovery instructions
If a session ends: read this file, `git log --oneline`, `git status`; resume at the first phase not VERIFIED using `capture-prompts/RESUME.md`.
