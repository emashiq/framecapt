# Recording controls and audio lifecycle

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Build the recording state machine and real screen/window/region recording UI using the proven pipeline. Add countdown, elapsed timer, pause/resume/stop and floating compact controls. Separate wall-clock duration from active recording duration. Support microphone/system audio independently, device selection, visible mute state and levels.

Ensure requested microphone/system audio streams are mixed appropriately into one recording audio track without output monitoring/feedback. Watch track mute/ended events, source loss and device changes. Handle no-audio recording as a valid mode. If selected audio is unavailable, show a clear preflight choice rather than quietly producing silent output.

Bound the size of any temporary in-memory prototype buffer and immediately integrate with the disk session interfaces used by phase 06. Stop must be idempotent across toolbar, shortcut, source loss and window close. Keep recorder state owned coherently across windows; don't instantiate multiple independent recorders.

Acceptance: state-transition tests include rapid start/stop/pause, cancellation during start and duplicate stop. Real Windows validation covers mic-only/system-only/both/neither and pause/resume sync. Verify captured output excludes controls where feasible; if OS exclusion isn't dependable use an alternative placement/hiding design.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

