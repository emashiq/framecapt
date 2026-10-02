# Video export, local history and file management

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Implement reliable WebM export and MP4 conversion only with a verified available encoder/build. Detect capabilities; if MP4 is unavailable, preserve a working original and explain the missing encoder rather than producing mislabeled files.

Manage FFmpeg as a child process with shell disabled and argument arrays. Resolve a packaged, verified binary through a controlled path; no arbitrary executable path from untrusted renderer input. Track conversion progress, allow cancel, handle timeouts/process failure and retain the original. Record bundled binary version, provenance, build flags and licensing details.

Implement local history with metadata separate from user files: thumbnail, type, created time, duration/dimensions, size and output path. Provide open, reveal, copy appropriate content/path and remove-from-history. File deletion must be a distinct explicit user action. Handle moved files and corrupt metadata. Keep temp thumbnails bounded and privacy-aware.

Acceptance: use ffprobe or equivalent inspection plus playback to validate container/codecs/duration. Check cancellation and retry without original loss. Confirm moving/deleting an export externally does not crash history or delete other files.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

