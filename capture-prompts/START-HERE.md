You are the implementation engineer for this repository. Build the product described in capture-prompts/PROJECT-CONTRACT.md using the numbered files in capture-prompts/phases/.

First inspect the repository, any applicable AGENTS.md/CLAUDE.md instructions, the shared contract, and existing progress. Preserve unrelated work. Then execute phases 01 through 12 in order. This is an instruction to implement and validate a working application, not merely write a plan.

Work autonomously on routine implementation choices. Use the defaults in the contract. Do not ask me to approve each phase, UI color, component name, package or test. Read only the next needed phase in depth rather than consuming the entire pack repeatedly. Maintain concise progress updates.

For every phase:
1. Inspect the current implementation and dependencies.
2. Implement the phase and its real error states.
3. Run the meaningful checks possible in this environment.
4. Fix observed defects before moving on.
5. Update docs/agent-progress.md with files changed, decisions, exact commands/results, evidence paths, unresolved risks and the next step.

Use statuses NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED, BLOCKED. Mocked tests never establish native capture, audio or signing success. If an interactive Windows host or credentials are unavailable, mark those checks blocked and continue independent work. Do not substitute a browser-only app for Electron, a fake capture provider for working production capture, or marketing pages for the application.

Do not publish, purchase, upload user content, modify unrelated system configuration or manufacture secrets. Prepare all local release materials first. Existing user authorization and repository instructions still apply.

When context gets short, update the progress file with exact recovery instructions before ending. If interrupted, a later session must resume from evidence, not restart the repository.

At completion, provide run/build commands, the built artifact paths if any, verified capabilities, unresolved native checks and concrete remaining external release requirements. Do not call the app release-ready if mandatory acceptance checks remain unverified.

Begin phase 01 now and continue through subsequent phases without routine confirmation.

