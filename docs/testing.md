# Testing

| Suite               | Command                                    | Needs                                           | What it proves                                                                                      |
| ------------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Lint / types        | `npm run lint`, `npm run typecheck`        | Node 24                                         | Style and the three TypeScript projects (main/shared, renderer, e2e)                                |
| Unit + integration  | `npm test`                                 | the vendored FFmpeg for the integration files   | Pure logic, IPC security, the app:// resolver, the update adapter, real-FFmpeg finalize and export  |
| E2E (mock capture)  | `npm run test:e2e`                         | Windows desktop; builds the E2E app first       | The real UI, IPC, recorder pipeline and session service with a synthetic capture provider           |
| Native              | `npm run test:native`                      | an interactive desktop, real screens and audio  | Real capture, SendInput shortcuts, forced-kill recovery, failure modes                              |
| Packaged smoke      | `npm run smoke:packaged` (after `package`) | Windows                                         | The fused, packaged exe loads its UI from app://framecapt and keeps its security properties         |
| Installed smoke     | `npm run smoke:installed` (after `make`)   | an interactive desktop; **installs on this PC** | Silent Squirrel install, real capture through the shortcuts, FFmpeg export, 60 s offline, uninstall |
| Recording benchmark | `npm run bench:recording`                  | an interactive desktop, 30 minutes              | `docs/performance.md`                                                                               |

Run order used for a release candidate: `lint`, `typecheck`, `test`, `test:e2e`, `test:native`, `make`, `smoke:installed`.

## Evidence files are not rewritten by ordinary runs

The e2e and native suites take UI screenshots and write redacted JSON summaries that earlier phases committed under `docs/evidence/phaseNN/`. A normal run must not touch those files, so evidence is **gated by an environment variable**:

```
FRAMECAPT_WRITE_EVIDENCE=1 npm run test:e2e
FRAMECAPT_WRITE_EVIDENCE=1 npm run test:native
```

- Unset (the default): every test still produces its screenshots and JSON and asserts on them, but they go to a scratch folder, `%TEMP%\framecapt-evidence-scratch\<phase>\`. Nothing under `docs/evidence` changes.
- `FRAMECAPT_WRITE_EVIDENCE=1`: the files are written to `docs/evidence/<phase>/` (this is how the committed evidence was produced).
- The mechanism is one helper, `evidenceDirFor(repoRoot, phase)` in `tests/native/evidence.ts`. Evidence JSON always goes through `writeEvidenceJson`, which redacts window titles and the Windows user name.
- The integration tests that already used `FRAMECAPT_WRITE_EVIDENCE` (`ffmpeg-integration`, `export-integration`) are unchanged. `npm run smoke:installed` and `npm run bench:recording` are explicit evidence-producing commands and always write theirs.
- Media evidence (`*.webm`, `*.mp4`, most `*.png`) stays gitignored because it shows the real desktop; only mock-content UI screenshots are tracked.

## Why the packaged exe is not driven by Playwright

The shipped build has `EnableNodeCliInspectArguments` off, which Playwright needs. E2E therefore runs the Forge build output (`.vite/build`, `electron .`) with the mock provider compiled in (`scripts/package-e2e.mjs`); `npm run check:mocks` proves that no production build and no packaged `app.asar` contains it. The packaged and installed exes are exercised by `smoke:packaged` / `smoke:installed`, which use the Chromium remote-debugging port for read-only UI checks and real OS input (SendInput) for capture.

## What runs where

- **Local, interactive Windows host**: everything.
- **GitHub Actions (`.github/workflows/ci.yml`, `windows-latest`)**: lint, typecheck, unit tests, the mock-provider e2e suite, `npm run make` and `check:mocks`. Native capture tests, the installed smoke and the 30-minute benchmark are **not** run on hosted runners (no real display, audio or shortcut environment is guaranteed, and the installed smoke installs software). They remain local gates; see `docs/packaging.md`.
- Screen-reader testing and mixed-DPI / rotated / negative-origin monitors have not been performed on real hardware (see `docs/agent-progress.md` risks).

## Known flake: the Playwright worker dies during `electron.launch()`

Rarely (about 1 launch in 600; 3 crashes in about 2 000 `desktop.spec.ts` tests, never in a particular test) the Playwright **worker** (the Node 24.15 process that drives the tests) exits with `code=3221226505` (0xC0000409, a fast-fail). Playwright reports the test that was starting as failed after 0 ms. It is not caused by the app or by how tests close it: it was reproduced on the phase 09 commit, the same app exits cleanly in the other ~99.8 % of launches, and the orphaned Electron left behind each time is a _main_ process with only its GPU and network helpers and **no window**, i.e. the app was still held in Playwright's loader waiting for a debugger that no longer existed, so the worker died inside the launch handshake (spawn through `cmd.exe`, read the debugger URL, connect the WebSocket). No Windows error report or dump is produced for it, so the native cause (Node/libuv or Playwright, on this host) is not identified.

Mitigations, both in the test tooling:

- `npm run test:e2e` runs `scripts/run-e2e.mjs`. If every failure of a run is that exact worker death, only those tests are run once more (`--last-failed`); any other failure, or a second crash, fails the run. `npx playwright test` directly does not retry.
- `tests/e2e/global-teardown.ts` (e2e and native configs) ends any Electron process tree that Playwright started from this repository and nobody closed, so a crash cannot leave tray icons, user-data locks or (outside the mock-shortcut build) global shortcuts behind. A developer's own `npm start` is not touched.

## Hosted CI runners (GitHub Actions) and the E2E suite

The hosted `windows-latest` runner has **one physical core (two threads), no GPU, no audio device** and varies a lot from VM to VM: the same recording test takes 6 s on a development PC and 15 s to over a minute there, and the whole VM can stall for seconds while the recorder renderer encodes video. What was done, and what is still timing noise:

- E2E build only (`__FRAMECAPT_E2E__`): the synthetic display paints its backdrop once and moves one block at 10 fps, and the recorder prefers VP8 over VP9. Production keeps VP9 first.
- When `CI` is set, `playwright.config.ts` raises the test timeout to 120 s and the default `expect` timeout to 15 s, and retries a failed test twice (traces kept). Locally there are no retries. Retries are only a backstop for VM timing noise: a test that fails three times in a row is a real failure.
- The lost-microphone test passes `--use-fake-device-for-media-stream` (the runner has no microphone).
- Defender real-time scanning is switched off on the (disposable) E2E runner.
- Tests that were racing on slow machines and were made deterministic, not looser: the 3-2-1 countdown (digits are recorded by a page-side observer; the "3" may be missed if the window attaches late), recovery (waits for the session folder to go and ignores `.partial.webm` files), the pause test (its duration bound follows the measured wall clock), and "rapid start and stop" (it used to send Stop while the recorder was still `idle`, which is a no-op, so the second Start then ran; it now waits until the recorder has left `idle`).
- Product check for that last one: a Stop while the engine is still starting is a cancel and a late "started" from a slow engine is ignored (`tests/unit/recorder-races.test.ts`, and `tests/e2e/recording-slow-start.spec.ts` with the E2E-only `FRAMECAPT_E2E_ENGINE_START_DELAY_MS` hook). No recorder can be left in `recording` by a quick Start/Stop.
- Linux (`ubuntu-latest`): the network test samples sockets with `ss`. It found a real leak, fixed on all platforms: the session spellchecker downloaded a Hunspell dictionary from Google (`src/main/security.ts` `disableSpellChecker`, `tests/unit/spellchecker.test.ts`).
