# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in a public issue or pull request.

- Contact: `[OWNER: add security contact]` (an email address or private reporting channel, to be added by the project owner before the repository is made public).

Until that contact exists, no private reporting channel has been published. Include: the affected version, Windows version, steps to reproduce, the impact you expect, and whether the issue is already public. Do not attach real captures or recordings with sensitive content; the log `%APPDATA%\FrameCapt\logs\main.log` is diagnostic only (paths have the user-name part replaced by `~`), but read it before sending.

Response targets are the owner's to set; none are promised yet (`[OWNER: add response time target]`). Please allow reasonable time for a fix before public disclosure.

## Supported versions

FrameCapt is in **beta**, version 0.1.0, not yet released. Only the latest release (once one exists) is supported with security fixes; there are no long-term-support branches.

| Version | Supported                    |
| ------- | ---------------------------- |
| 0.1.x   | Yes, once released (beta)    |
| older   | Not applicable (no releases) |

## Scope

In scope: the FrameCapt application code in this repository (main, preload, renderer processes), its IPC surface, the `app://` and `framecapt-media://` protocol handlers, file handling (sessions, history, settings, exports), the way FFmpeg is launched, and the build/packaging configuration (including the Electron fuses and CI workflows).

Out of scope or handled upstream: vulnerabilities in Electron/Chromium themselves, FFmpeg or other third-party components (report them to those projects; tell us so we can update the pinned version), attacks that need prior write access to the user's own profile folder (`%APPDATA%\FrameCapt`) as the same Windows user, the lack of code signing on current builds (known; see [docs/packaging.md](docs/packaging.md)), and physical access attacks.

## What to know about the design

FrameCapt makes no network requests of its own and has no update feed configured. The renderer runs sandboxed with context isolation, validated IPC and a strict CSP. The security review, its findings and the remaining known risks are in [docs/security-review.md](docs/security-review.md). A passing review in that document is not a guarantee that no vulnerabilities exist, and it was not performed by an independent third party.
