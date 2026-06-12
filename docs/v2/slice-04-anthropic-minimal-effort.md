# Slice 4 Parity Follow-up: Anthropic Minimal Effort Mapping

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` Anthropic effort mapping for `minimal`

## `v1` Oracle
- current `v1` Anthropic requests preserve `effort = "minimal"` when that is the selected session value
- current `v1` only remaps `max -> high` when the selected Anthropic model does not support true `max`

## Implemented In `v2`
- updated the shared Anthropic effort mapper so `minimal` is preserved instead of being downgraded to `low`
- kept the existing `max -> high` handling for models that do not support true `max`
- added focused provider-runtime coverage proving Anthropic now emits `output_config: { effort: "minimal" }` when appropriate

## Hidden Gap Found During Re-audit
- `v2` was still downgrading Anthropic `minimal` to `low` in the shared mapper, which did not match the current in-repo `v1` builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- Anthropic minimal-effort parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
