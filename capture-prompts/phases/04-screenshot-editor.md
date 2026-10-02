# Screenshot annotation and safe export

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Implement an editor with pan/zoom, crop, arrow, rectangle, text, opaque redaction and undo/redo. Store edits in image coordinates independent of CSS zoom and devicePixelRatio. Choose a small maintained canvas library or a simple internal implementation; avoid a general design-tool framework.

Flatten all edits into exported PNG/JPEG and copied clipboard pixels. Redaction is a solid irreversible cover in the exported raster, not translucent blur, a CSS layer or a retained hidden original. Update history thumbnails from the final flattened result. Explicitly distinguish an original retained for editing from the redacted exported artifact.

Implement unsaved-change handling, keyboard shortcuts within editor scope and font/text bounds that remain correct at export resolution. Treat original captures as private local data; do not upload them.

Acceptance: inspect or test exported pixels under redacted regions; verify undo/redo/crop interactions and export dimensions. Show real exported artifacts if host tools allow. No claim of redaction safety based only on how the editor looks.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

