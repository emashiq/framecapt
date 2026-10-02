# Final acceptance checklist
For each item record PASS, FAIL, BLOCKED or NOT_APPLICABLE, environment, evidence and date. IMPLEMENTED alone is not PASS.

## Build and distribution
- Clean install using lockfile; lint, typecheck and meaningful automated tests.
- Electron app starts from source and packaged Windows install.
- Install, launch, uninstall; user captures preserved on uninstall.
- Production preload paths, resources, FFmpeg and renderer assets resolve.
- Update checks safely inactive without configuration; configured release path documented and tested before public use.

## Screenshot
- Full-screen, individual window and selected region at correct pixel resolution.
- Two monitors including a negative origin and mixed DPI; rotation if supported.
- Escape/cancel restores focus and leaves no overlay.
- Arrows/text/boxes/crop and undo/redo survive zoom.
- Opaque redaction is flattened in PNG, JPEG and clipboard exports.
- No unredacted preview/history leak after saving redaction.

## Video/audio
- Screen/window/region; screen/region on each monitor separately.
- Mic only, system only, both, neither; mute/unmute and device disconnect.
- Source closure, permission denial, no audio track and rapid repeated commands.
- Pause/resume yields correct timeline and A/V sync.
- Stop is idempotent; no leaked tracks, windows or child processes.
- 30-minute 1080p/30fps recording on real Windows hardware; measured memory/CPU and A/V sync.
- WebM and MP4 outputs probe correctly and play; conversion cancel/failure preserves original.
- No accidental recording of selection overlay/controls.

## Reliability/security
- Bounded recorder queue; disk-full and write failure handled.
- Forced termination tested at capture and finalization stages; recovery limits documented.
- Path validation, IPC sender/payload validation and unauthorized requests rejected.
- FFmpeg invocation has no shell interpolation; dependencies/attributions checked.
- No unsolicited network traffic/uploads; diagnostics omit sensitive capture content.
- Settings corruption and missing history files handled without losing user recordings.

## Commercial/public release
- Canonical project license and dependency notices.
- Exact bundled FFmpeg licensing and source obligations recorded.
- Working name/branding ownership and release identity resolved by owner.
- Certificates/accounts/payment eligibility resolved; no fake checkout.
- Paid-offer terms identify update/support scope and open-source rights.
- All blockers shown prominently in RELEASE-READINESS.md.

