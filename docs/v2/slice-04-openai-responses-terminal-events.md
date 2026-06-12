# Slice 4 Parity Follow-up: OpenAI Responses Terminal Events

## Goal
- restore the current `v1` terminal-event handling on the OpenAI Responses streaming path

## `v1` Oracle
- `v1` treats both `response.completed` and `response.done` as terminal completion events on the Responses path
- `v1` also surfaces `response.failed` as a real error event instead of silently ignoring it
- the shared chat path depends on that normalization so usage, completion, and visible failures resolve consistently

## Implemented In `v2`
- OpenAI Responses runtime now treats both `response.completed` and `response.done` as terminal completion events
- the same runtime now surfaces `response.failed` as an error instead of ignoring that event family
- focused provider-runtime coverage now proves `response.done` still yields completion usage and a non-truncated result

## Hidden Gap Found During Re-audit
- `v2` had already restored the Responses transport and default reasoning shape, but its parser was still narrower than the current `v1` oracle
- that left `response.done` and `response.failed` handling thinner than the current in-repo `v1` behavior

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- OpenAI Responses terminal-event parity is now restored inside the audited Slice 4 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
