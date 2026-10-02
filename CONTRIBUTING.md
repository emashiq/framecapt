# Contributing to Framelet

Thanks for your interest. Framelet is a Windows-first, offline screenshot and screen-recording app (Electron, TypeScript, React, Vite) licensed under GPL-3.0-only. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing of contributions

Contributions are accepted under the project license, **GPL-3.0-only** (the "inbound = outbound" convention). There is **no Contributor License Agreement** and no copyright assignment: you keep the copyright in your work. You may add a `Signed-off-by: Your Name <you@example.com>` line to your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/); this is encouraged but optional. Do not contribute code you do not have the right to license under the GPL, and do not copy icons, images, fonts or code with an incompatible license. New runtime dependencies must be GPL-3.0-compatible and must be added to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development setup

See [docs/building-on-windows.md](docs/building-on-windows.md). In short: Windows, Node.js 24, npm, git, then:

```
npm ci
npm start
```

## Before you open a pull request

Run, and make pass:

```
npm run lint
npm run typecheck
npm test
npm run test:e2e        # when you touch UI, IPC, recording or export
```

`npm run test:native` needs an interactive desktop and real capture hardware; run it if you can for capture, recording, shortcut or recovery changes, and say in the PR whether you did. Do not delete or skip a failing test to get green.

## Code style

- TypeScript strict mode; ESLint and Prettier decide formatting (`npm run format`: single quotes, semicolons, trailing commas, 100 columns, LF line endings).
- Match the existing structure: `src/main` (main process: capture authorization, windows, tray, shortcuts, files, FFmpeg), `src/preload` (a small typed allowlist), `src/renderer` (UI, editor, recorder pipeline), `src/shared` (types, zod schemas, pure logic).
- Keep code small and clear; no speculative abstractions.
- **Security rules** (see [docs/security-review.md](docs/security-review.md)): `contextIsolation` on, `nodeIntegration` off, sandbox on; every IPC channel validates its payload with zod and checks the sender; never expose `ipcRenderer` or arbitrary filesystem/process access to the renderer; renderer code never supplies file paths (use save/open dialogs in main or main-owned ids); child processes run with `shell: false` and an argument array; no network requests, telemetry or remote media processing.
- **Redaction** must always flatten into exported pixels. **User files** are never deleted silently; deletion goes to the Recycle Bin on explicit confirmation.
- Tests are required for behavior changes: unit tests for logic (`tests/unit`), e2e for UI flows (`tests/e2e`, mock capture provider), native specs for real capture (`tests/native`). Mock providers are for automated tests only and must not end up in a production build (`npm run check:mocks`).
- Documentation must match behavior: update the relevant file in `docs/` and the [CHANGELOG](CHANGELOG.md) when you change something users or maintainers will notice. Do not claim something is verified unless you ran it.

## Pull request checklist

- [ ] The change is focused and described (what and why)
- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass
- [ ] `npm run test:e2e` passes (if UI/IPC/recording/export changed); native tests run or noted as not run
- [ ] New or changed behavior has tests
- [ ] No new network access, telemetry or unvalidated IPC
- [ ] Docs and CHANGELOG updated; new dependencies added to THIRD_PARTY_NOTICES.md
- [ ] No secrets, certificates, personal data or real-desktop screenshots committed

The pull request template has the same list.

## Reporting bugs and ideas

Use the issue templates. Security problems: do **not** open a public issue; follow [SECURITY.md](SECURITY.md).
