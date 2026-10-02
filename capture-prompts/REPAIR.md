Fix this defect in Framelet:
[Paste reproduction steps, observed behavior, expected behavior, and any logs here.]

Read the project contract, applicable repository instructions and current progress. Reproduce the defect where possible; trace it through the existing architecture and identify the root cause. If native access is unavailable, instrument the relevant path and clearly label the remaining reproduction check.

Implement the smallest coherent fix, preserving unrelated work. Add a regression check when it exercises a meaningful failure mode. Run relevant existing checks and inspect adjacent capture/audio/file-lifecycle behavior affected by the change. Do not broadly rewrite the app, hide exceptions, remove failing tests, bypass permissions or replace native behavior with production mocks.

Update docs/agent-progress.md and relevant documentation. Report cause, fix, exact validation and any remaining host-specific verification. If the defect description still contains only the placeholder, ask for the defect instead of inventing one.

