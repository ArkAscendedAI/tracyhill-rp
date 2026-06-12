# Slice 4 Parity Follow-up: OpenAI Responses Default Reasoning

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` default reasoning payload on the OpenAI Responses path

## `v1` Oracle
- `v1` OpenAI Responses requests always send a `reasoning` block for built-in reasoning-capable models
- when no explicit effort is set, `v1` still defaults that payload to `{ effort: "high", summary: "auto" }`

## Implemented In `v2`
- updated the shared OpenAI Responses runtime so it always emits a `reasoning` block, defaulting to `high` effort when the session/runtime payload does not provide an explicit effort value
- preserved the existing effort mapping for explicit session values, including `max -> high`
- added focused provider-runtime coverage proving the default reasoning payload is still present when no explicit effort is set

## Hidden Gap Found During Re-audit
- `v2` was still omitting the OpenAI Responses `reasoning` block entirely when no explicit effort reached the runtime, which did not match the current in-repo `v1` builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- OpenAI Responses default-reasoning parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
