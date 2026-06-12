# Slice 4 Parity Follow-up: OpenAI Minimal Effort Mapping

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` OpenAI Responses effort mapping for `minimal`

## `v1` Oracle
- current `v1` OpenAI Responses requests preserve `effort = "minimal"` when that is the selected session value
- current `v1` only remaps `max -> high` on the Responses path

## Implemented In `v2`
- updated the shared OpenAI Responses effort mapper so `minimal` is preserved instead of being downgraded to `low`
- kept the existing `max -> high` normalization that matches current `v1`
- added focused provider-runtime coverage proving the Responses payload now keeps `reasoning: { effort: "minimal", summary: "auto" }`

## Hidden Gap Found During Re-audit
- `v2` was still downgrading `minimal` to `low` in the shared OpenAI Responses mapper, which did not match the current in-repo `v1` builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- OpenAI Responses minimal-effort parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
