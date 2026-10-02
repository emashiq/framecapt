# Electron Screen Capture — Claude Sonnet Prompt Pack
Prepared for Emran • 2026-10-02

This is a build instruction pack, not a finished application. Use it with Claude Sonnet in a coding agent that can read/write your repository and run terminal commands. A chat-only session cannot autonomously implement or test the application.

## Quick start
1. Extract this ZIP.
2. Place the entire `capture-prompts` directory in your intended project root. An empty project directory is fine.
3. Open that project in your Claude coding environment and select your available Sonnet model.
4. Paste the text from `START-HERE.md` as your first message.
5. Allow ordinary project-local file edits, dependency installation and tests through your environment's normal permission settings. Do not disable its safeguards.
6. Claude should execute phases 01–12 and maintain `docs/agent-progress.md`.
7. If the session ends, paste `RESUME.md`. For a specific defect, use `REPAIR.md`.

You can instead run files in `phases/` individually, in numeric order. Each phase tells Claude to read the shared project contract first. Run phases in the same repository; don't start a new project for each prompt.

## What it builds
Windows-first Electron + TypeScript + React + Vite application:
- Screen/window/region screenshots; annotation, copy and save.
- Screen/window/region recording; microphone and system-audio controls.
- Pause/resume, shortcuts, tray and a floating recording toolbar.
- Local history; disk-backed recording; verified export and recovery behavior.
- Windows installer configuration, CI, documentation and commercial release preparation.

Temporary project name: **Framelet**. It is a working name, not a verified available trademark.
Commercial direction: fully open-source desktop application, with an optional paid official distribution/support offering. Proposed price: $15 one-time for the current major version and 12 months of updates. No artificial feature locks in the open-source build.

## Execution limits
Autonomous means making routine implementation decisions and continuing until the work is complete or genuinely blocked. It does not mean buying certificates, publishing releases, creating paid accounts, uploading recordings, or claiming unrun tests passed.
Native capture/audio validation needs an interactive Windows session. Headless/Linux work can implement and test much of the app, but cannot establish Windows capture quality.
OS permission dialogs and any required account credentials may need user action. Continue independent work and record blocked checks precisely.

## Files
- START-HERE.md — master execution prompt.
- PROJECT-CONTRACT.md — scope, architecture, safety and acceptance rules.
- phases/01–12 — sequential implementation prompts.
- RESUME.md — recover context and continue.
- REPAIR.md — diagnose and fix a reported bug.
- ACCEPTANCE-CHECKLIST.md — final verification matrix.
- SOURCES.md — primary documentation to recheck at implementation time.

There is deliberately no script that repeatedly invokes an agent without checking results or bypasses its permission system.

