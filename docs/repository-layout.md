# Repository layout

The repository is a desktop-only npm workspace (`apps/desktop`) with one root `package-lock.json`. The Electron
application lives in `apps/desktop`; its `package.json` is authoritative for desktop identity
(`framecapt`, product `FrameCapt`) and version (`0.1.0-alpha.3`). Root scripts forward to that workspace and
keep the established desktop command names. Run `npm ci` at the repository root, then use `npm start`,
`npm test`, `npm run typecheck`, `npm run make`, or any app-specific `*:desktop` command. Script arguments pass
through the root aliases, for example `npm run test:desktop -- tests/unit/ffmpeg.test.ts -t development`.

| Path | Content |
| --- | --- |
| `apps/desktop/src`, `tests`, `assets`, `scripts` | the app, its tests, brand assets and build scripts |
| `apps/desktop/forge.config.ts`, `vite.*.config.ts`, `vitest.config.mts`, `playwright*.config.ts`, `tsconfig*.json` | build and test configuration |
| `apps/desktop/vendor`, `.vite`, `out` | build and cache output |
| `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/` | repository root |

Desktop development paths such as `vendor/ffmpeg`, `.vite`, and `out` resolve from the desktop workspace. Evidence
writers resolve `docs/evidence` from the repository root. Forge receives the license and notices by absolute
repository-root paths. Moving source folders does not change Electron `userData`, Pictures, or Videos locations.

Use `.env.example` for checked-in placeholders. Real `.env` files are ignored at the root.

There is no backend, website or account system in this repository: the app is fully local. That work is preserved on
the branch `login-website`.
