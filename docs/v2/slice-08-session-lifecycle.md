# Slice 8 Parity Follow-up: Session Lifecycle

This follow-up restores the largest remaining `v1` wizard behavior gap: the dedicated wizard session lifecycle.

## What Changed
- `sessions` now persist `session_type` with `standard` and `wizard`.
- workspace session creation can now create exactly one active wizard session per user.
- wizard sessions are pre-seeded with the same conversation-opening user/assistant messages used by `v1`.
- wizard session chat now runs with the dedicated wizard system prompt plus the user's persisted example-template references.
- the web shell now exposes:
  - a dedicated wizard slot in the sidebar
  - `New Campaign Wizard`
  - discard/replace flow for the active wizard session
  - in-session `Generate Campaign` gating once `[WIZARD_READY]` appears
- wizard generation can now enqueue directly from a real wizard session via `wizardSessionId`.
- approval now deletes the source wizard session, creates the campaign folder, creates `Part 1`, and switches the user into that session.

## Parity Impact
- closes the dedicated-session gap from `v1`
- closes the real-transcript gap by sourcing wizard generation from persisted session messages
- closes discard/cleanup parity for the wizard source session
- closes approval-time wizard-session cleanup parity

## Notes
- the campaign-panel wizard form remains available as an alternate operator path
- a later parity follow-up moved wizard review into a dedicated review surface, so this lifecycle increment should now be read together with `docs/v2/slice-08-review-surface.md`

## Verification
- `npm run typecheck`
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts wizardRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/worker -- wizardWorker.test.ts`
- `npm test`
- `npm run build`
- `npm run test:e2e`
