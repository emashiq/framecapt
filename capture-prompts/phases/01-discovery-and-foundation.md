# Repository discovery and foundation

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Inspect the repository, installed tooling, host OS/display availability and applicable instructions. Preserve existing work. For a blank repository, create a minimal Electron + React + TypeScript + Vite project using compatible stable dependencies and Electron Forge. Choose practical defaults without asking about routine setup.

Create docs/architecture.md, docs/decisions.md, docs/agent-progress.md and an initial capability matrix. Record supported Windows versions based on the selected Electron release, package versions, capture APIs, codec/export plan and unavailable host capabilities. Use a temporary Framelet app ID clearly marked for owner review before publication.

Implement a runnable window with secure preload bridge, restrictive CSP, basic application lifecycle, error boundary and typed IPC contract. Add useful npm scripts for development, lint, typecheck, tests and package/make. Keep package manager and lockfile consistent. No backend, database service or monorepo scaffolding unless already needed.

Acceptance: dependency installation and basic checks succeed; Electron window launch is verified if this host supports it. Otherwise report the exact launch blocker. Avoid claims that a successful web build establishes desktop functionality.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

