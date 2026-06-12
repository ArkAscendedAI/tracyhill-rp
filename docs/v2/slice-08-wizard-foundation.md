# Slice 8: Wizard Foundation

## Outcome
- `v2` now has the first worker-backed wizard vertical slice.
- Wizard templates persist in SQLite per user.
- Wizard runs persist in SQLite with durable step state and review output.
- The API exposes authenticated template CRUD plus wizard run list/enqueue/approve/retry routes.
- The worker can claim queued wizard runs, generate the four campaign documents, and persist review output.
- Approval creates a campaign, creates/links a campaign folder, creates `Part 1` inside that folder, and activates that session in workspace preferences.
- The web campaign panel now exposes a minimal wizard studio with template editing, run kickoff, latest-run polling, review display, and approval/retry controls.

## Scope
- Added `wizard_templates` and `wizard_runs`.
- Added shared wizard contracts.
- Added API repositories, service, controller, and routes.
- Added worker prompts and `WizardWorker`.
- Added web `wizardApi` plus campaign-panel wizard UI.

## Verification
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- This is the first usable wizard path, not final parity.
- The current UI uses a campaign-panel wizard studio instead of the later dedicated wizard session slot.
- Wizard template defaults now seed from the existing `v1` `server/wizard-defaults.js` source, and fully blank early-`v2` rows are backfilled on first access. (Update 2026-05-20: this V1 dependency was removed in commit B-001 by inlining the `DEFAULT_EXAMPLE_SYSTEM_PROMPT` template literal directly into `apps/api/src/domain/wizard/wizardDefaults.ts`. V2 wizard now has no runtime dependency on V1 files.)
- Wizard approval now restores the `v1` campaign-folder side effect.
- Transcript-backed generation is now restored through `wizardTranscript` persistence plus `<wizard_conversation>` worker prompts, but the dedicated wizard session lifecycle is still missing.
- Later Slice 8 parity follow-ups restored the dedicated wizard session lifecycle, operator controls, transcript sourcing from real wizard sessions, and the dedicated review surface.
