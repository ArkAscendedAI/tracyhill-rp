# Slice 8 Parity Follow-up: Operator Controls

## Scope
This parity follow-up restores the core wizard operator controls that were still missing after the transcript-context increment.

Implemented here:
- authenticated `GET /api/wizard/active` for user-level active/reviewable wizard discovery
- authenticated `POST /api/wizard/runs/:runId/cancel` for queued and running wizard runs
- worker-side abort handling with durable `canceled` terminal state
- campaign-panel cancel action for active wizard runs
- shell-level wizard activity banner for active or reviewable runs
- route, worker, full test, build, and browser coverage for active/cancel behavior

## Notes
- this restores active/cancel parity, but not the dedicated `v1` wizard session lifecycle
- the remaining major Slice 8 gap is the conversation-first wizard flow:
  - sidebar wizard slot
  - dedicated wizard session
  - `[WIZARD_READY]` gating
  - discard/session cleanup semantics tied to that session

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
