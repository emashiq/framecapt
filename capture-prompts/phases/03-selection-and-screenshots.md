# Source selection and screenshot workflow

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Build the home capture controls, source picker and per-display selection overlay. Provide screen, window and rectangular region modes, keyboard escape and focus restoration. Use one-monitor rectangular selections for MVP; crossing displays should be prevented clearly rather than mis-scaled.

Implement deterministic display-independent-to-pixel transforms with negative monitor origins, mixed scaling and actual captured frame dimensions. Handle screen changes between enumeration and capture. Remove selection overlays before capturing; avoid stale or low-resolution thumbnails as final screenshots.

Save PNG/JPEG using main-owned dialogs/paths and copy actual image bytes to the clipboard. Provide clear cancellation and error states. Keep the original in an explicit editing session rather than multiplying unmanaged temporary files.

Acceptance: coordinate transform tests cover mixed DPI and negative origins; native checks confirm full-screen/window/region fidelity. Cancel causes no capture, no phantom overlay and no dangling session. Document any minimized/protected-window limitation accurately.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

