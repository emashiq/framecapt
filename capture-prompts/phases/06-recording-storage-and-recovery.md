# Disk persistence, backpressure and recovery

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Replace all whole-recording accumulation with a production disk-backed session service. Design the container-aware persistence strategy before implementing. MediaRecorder timeslices may depend on initialization data; do not treat every emitted chunk as a standalone clip.

Use session IDs, sequential chunk numbers, validated maximum payload sizes, write acknowledgments, bounded queues and a manifest with source/configuration, timestamps and lifecycle state. Detect oversized chunks and disk pressure; choose safe stop/error behavior instead of unbounded buffering. Ensure final recorder events are flushed before closing files. Final output publication should be atomic where feasible.

Handle disk-full, permission error, source loss, quit during recording, abrupt termination and interrupted export. On restart identify incomplete sessions and offer a truthful recover/discard flow. Only delete app-owned temp files with clear provenance; never remove user exports. If a container cannot be repaired, retain diagnostics and explain that recovery is partial/unavailable.

Acceptance: test sequence rejection, duplicate chunks, slow writes, queue limits, finalization races and simulated write failures. Perform forced process termination/restart on a real recording if possible. Probe/play recovered outputs before labeling recovery successful. Document exact known recovery limitations.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

