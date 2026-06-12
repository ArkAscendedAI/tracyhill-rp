# Slice 7 Parity Follow-up: Operator Controls

## Scope
This parity follow-up restores the core operator controls that were still missing after the initial Slice 7 baseline.

Implemented here:
- user-level active pipeline discovery through `GET /api/pipeline/active`
- shell banner surfacing active or reviewable pipeline runs outside the campaign card itself
- stage-specific retry for validation, fix-only, and system-prompt reruns
- cancel route support for queued and running pipeline runs
- runtime-backed abort plumbing from the API route through the worker into provider fetch calls
- canceled terminal status plus route and worker coverage for abort behavior

## Notes
- the remaining major Slice 7 parity gap is now review-depth parity, not operator control parity
- true cross-process cancel semantics would still need coordination if pipeline execution ever moves out of the inline worker path used by the current app runtime

## Acceptance Evidence
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
