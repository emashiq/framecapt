# Testing

| Suite               | Command                                    | Needs                                           | What it proves                                                                                      |
| ------------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Lint / types        | `npm run lint`, `npm run typecheck`        | Node 24                                         | Style and the three TypeScript projects (main/shared, renderer, e2e)                                |
| Unit + integration  | `npm test`                                 | the vendored FFmpeg for the integration files   | Pure logic, IPC security, the app:// resolver, the update adapter, real-FFmpeg finalize and export  |
| E2E (mock capture)  | `npm run test:e2e`                         | Windows desktop; builds the E2E app first       | The real UI, IPC, recorder pipeline and session service with a synthetic capture provider           |
| Native              | `npm run test:native`                      | an interactive desktop, real screens and audio  | Real capture, SendInput shortcuts, forced-kill recovery, failure modes                              |
| Packaged smoke      | `npm run smoke:packaged` (after `package`) | Windows                                         | The fused, packaged exe loads its UI from app://framelet and keeps its security properties          |
| Installed smoke     | `npm run smoke:installed` (after `make`)   | an interactive desktop; **installs on this PC** | Silent Squirrel install, real capture through the shortcuts, FFmpeg export, 60 s offline, uninstall |
| Recording benchmark | `npm run bench:recording`                  | an interactive desktop, 30 minutes              | `docs/performance.md`                                                                               |

Run order used for a release candidate: `lint`, `typecheck`, `test`, `test:e2e`, `test:native`, `make`, `smoke:installed`.

## Evidence files are not rewritten by ordinary runs

The e2e and native suites take UI screenshots and write redacted JSON summaries that earlier phases committed under `docs/evidence/phaseNN/`. A normal run must not touch those files, so evidence is **gated by an environment variable**:

```
FRAMELET_WRITE_EVIDENCE=1 npm run test:e2e
FRAMELET_WRITE_EVIDENCE=1 npm run test:native
```

- Unset (the default): every test still produces its screenshots and JSON and asserts on them, but they go to a scratch folder, `%TEMP%\framelet-evidence-scratch\<phase>\`. Nothing under `docs/evidence` changes.
- `FRAMELET_WRITE_EVIDENCE=1`: the files are written to `docs/evidence/<phase>/` (this is how the committed evidence was produced).
- The mechanism is one helper, `evidenceDirFor(repoRoot, phase)` in `tests/native/evidence.ts`. Evidence JSON always goes through `writeEvidenceJson`, which redacts window titles and the Windows user name.
- The integration tests that already used `FRAMELET_WRITE_EVIDENCE` (`ffmpeg-integration`, `export-integration`) are unchanged. `npm run smoke:installed` and `npm run bench:recording` are explicit evidence-producing commands and always write theirs.
- Media evidence (`*.webm`, `*.mp4`, most `*.png`) stays gitignored because it shows the real desktop; only mock-content UI screenshots are tracked.

## Why the packaged exe is not driven by Playwright

The shipped build has `EnableNodeCliInspectArguments` off, which Playwright needs. E2E therefore runs the Forge build output (`.vite/build`, `electron .`) with the mock provider compiled in (`scripts/package-e2e.mjs`); `npm run check:mocks` proves that no production build and no packaged `app.asar` contains it. The packaged and installed exes are exercised by `smoke:packaged` / `smoke:installed`, which use the Chromium remote-debugging port for read-only UI checks and real OS input (SendInput) for capture.

## What runs where

- **Local, interactive Windows host**: everything.
- **GitHub Actions (`.github/workflows/ci.yml`, `windows-latest`)**: lint, typecheck, unit tests, the mock-provider e2e suite, `npm run make` and `check:mocks`. Native capture tests, the installed smoke and the 30-minute benchmark are **not** run on hosted runners (no real display, audio or shortcut environment is guaranteed, and the installed smoke installs software). They remain local gates; see `docs/packaging.md`.
- Screen-reader testing and mixed-DPI / rotated / negative-origin monitors have not been performed on real hardware (see `docs/agent-progress.md` risks).

## Known flake: a Playwright worker crash in `desktop.spec.ts`

Roughly one full run of `tests/e2e/desktop.spec.ts` in three occasionally ends with `worker process exited unexpectedly (code=3221226505)` (0xC0000409) on the test **after** the one that just finished; that test is reported as failed after 0 ms and the others pass. It is **not** caused by phase 10: the same crash was reproduced on a clean export of the phase 09 commit (1 of 6 runs). Root cause not investigated (it is in the Playwright node worker, not in the app). A crash can leave the Electron processes of that run behind; they hold the global shortcuts, so kill any stray `electron.exe` before running `test:native` or `smoke:installed`. Re-running the file is the workaround.
