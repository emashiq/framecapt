# Final end-to-end verification and handoff

Implement this phase now. First read capture-prompts/PROJECT-CONTRACT.md, applicable repository instructions and docs/agent-progress.md if present. Inspect current code; preserve completed work. Apply the shared contract throughout. If prerequisite work is missing, complete the smallest necessary dependency first and document it.

Run the full application workflow and capture-prompts/ACCEPTANCE-CHECKLIST.md. Reuse valid recent evidence, rerunning affected checks after fixes. Inspect the installed package where available, not only the development build.

Fix remaining feasible defects autonomously. Do not spend unlimited time on external blockers; prepare exact steps and continue other validation. Record PASS/FAIL/BLOCKED per capability and distinguish native tests from simulated ones.

Produce docs/RELEASE-READINESS.md with:
- Delivered features and explicitly deferred scope.
- Reproducible development, test, package and install commands.
- Verified OS/hardware/version matrix and evidence paths.
- Artifact paths and hashes if generated.
- Security/licensing/signing/payment/release status.
- Known bugs, performance measurements and recovery limitations.
- Concrete owner actions, prioritized by whether they block beta or public sale.

Update docs/agent-progress.md with final phase statuses and next actionable step. Report a working local beta only if capture, file saving and installed behavior were actually verified; otherwise say implemented with native verification pending. Never claim the entire task passed because unit tests did.

Finish with a concise delivery summary containing what works, how to launch, what was actually tested and what remains. Do not deploy or publish the product as part of this phase.

Before completing this phase, update docs/agent-progress.md with status, files changed, decisions, exact verification commands/results, evidence and unresolved blockers. Do not substitute a plan for implementation or mark unavailable native checks passed. When invoked by START-HERE.md, continue to the next phase automatically.

