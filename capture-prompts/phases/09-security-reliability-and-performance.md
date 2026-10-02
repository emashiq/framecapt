# Security, reliability and performance pass

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Review actual code, not just the intended architecture. Audit all IPC handlers/senders, renderer navigation, CSP, preload exports, session/path ownership, FFmpeg execution and external link handling. Fix concrete findings and record residual risks. Ensure production mocks are impossible to enable accidentally in normal builds.

Exercise the acceptance checklist's failure modes. Add regression coverage for meaningful risks: unauthorized IPC/path access, recording finalization races, state-machine errors, coordinate transforms and redaction pixels. Do not add large suites that only mirror trivial implementation.

Run a 30-minute 1080p/30fps benchmark on available interactive Windows hardware. Record process-tree memory/CPU, queue high-water mark, disk growth, output duration/frame characteristics and start/end audio sync. If unavailable, provide an executable/manual measurement procedure and label results BLOCKED; do not substitute generated media for capture benchmark evidence.

Investigate actual memory leaks, timers, repeated thumbnail work and expensive canvas operations. Optimize evidence-backed bottlenecks while keeping behavior correct. Set and document numeric performance thresholds from measured baseline rather than inventing successes.

Acceptance: docs/security-review.md and docs/performance.md contain findings, fixes, commands/environment and honest verification. All observed critical data-loss/privacy bugs are fixed or explicitly block release.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

