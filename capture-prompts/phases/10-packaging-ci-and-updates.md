# Windows packaging, CI and updates

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Configure Electron Forge packaging for a Windows installer with correct preload/assets/FFmpeg resources and a clearly provisional app identity. Verify clean install/build with lockfile. Use a Windows CI job for native package/build checks, and portable jobs only where appropriate.

Build automation must run lint/typecheck/tests/build and upload build artifacts. Avoid publishing publicly on ordinary branch pushes. Prepare a manual release workflow with minimum token permissions and documented secret names; no fake signing keys or committed tokens.

Implement an update adapter consistent with the chosen packaging system and current Electron/Forge docs. Without a real configured update source, show updates as unconfigured and make no invalid network requests. Prepare signing/update documentation and configure optional credentials through environment/CI secrets. Never label an unsigned installer signed.

Acceptance: test installed Windows application, resource resolution, real capture/export from packaged app and uninstall preserving user files. If a Windows host or certificate is missing, distinguish unsigned build success from signing/installed-runtime checks. Record artifact paths/hashes and exact blocked steps. Do not publish or purchase anything.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

