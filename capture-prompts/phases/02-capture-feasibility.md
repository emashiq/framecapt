# Capture and performance feasibility

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Implement a real CaptureProvider boundary and a small diagnostic UI for display/window enumeration, capture authorization and a short recording. Verify full-resolution screenshot extraction, Windows system audio request handling and microphone access for the pinned Electron version.

Prototype cropped region video with a canvas on one monitor. Evaluate frame rate, supported MediaRecorder formats, cleanup and audio graph mixing. Do not build the polished editor yet. Handle denial, cancelled picker, ended track and absent system audio explicitly; never silently advertise unavailable audio.

Add a reproducible benchmark procedure and docs/capture-feasibility.md. Measure on real hardware if available; otherwise leave measured fields empty with BLOCKED status and keep production paths real. Select format defaults from capability detection. Decide whether the browser pipeline meets MVP needs; record a bounded alternative if evidence says it does not.

Acceptance: a short captured file plays with expected visual region and requested audible tracks on a real Windows host, or that native validation is clearly blocked. The implementation must release all tracks/audio contexts after stop/cancel. Keep subsequent work possible when the host is headless.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

