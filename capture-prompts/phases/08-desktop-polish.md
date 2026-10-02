# Tray, shortcuts, settings and accessible desktop UX

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Add tray actions, global shortcut registration/configuration and the final compact floating toolbar. Resolve shortcut conflicts visibly. Implement predictable close-to-tray/quit behavior and safe active-recording quit handling. Startup-at-login is opt-in.

Persist versioned settings with validation, atomic writes, defaults and a repair path for corruption. Include output directory, screenshot format, recording quality, selected devices where still available, theme and shortcuts. Do not put credentials into plain settings.

Polish the complete flow: home → source/region → screenshot editor or recording → result → history. Add keyboard navigation, accessible labels, visible focus, theme contrast, loading/progress/cancel states and useful error messages. Avoid fake loading states and decorative complexity.

Acceptance: verify tray and shortcuts on Windows, focus after overlay dismissal, keyboard-only main flow and configuration persistence. Confirm no background busy loops/source thumbnail polling while idle and no duplicate tray/shortcut registrations after reopening windows.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

