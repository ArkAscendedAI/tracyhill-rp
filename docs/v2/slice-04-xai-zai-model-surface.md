# Slice 4 Parity Follow-up: xAI And z.ai Chat Model Surface

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` built-in xAI and z.ai chat model surfaces

## `v1` Oracle
- `v1` exposes nine built-in xAI chat models:
  - `grok-4`
  - `grok-4-fast-reasoning`
  - `grok-4-fast-non-reasoning`
  - `grok-4-1-fast-reasoning`
  - `grok-4-1-fast-non-reasoning`
  - `grok-4.20-beta-0309-reasoning`
  - `grok-4.20-beta-0309-non-reasoning`
  - `grok-3`
  - `grok-3-mini`
- `v1` exposes five built-in z.ai chat models:
  - `glm-5`
  - `glm-4.7`
  - `glm-4.7-flashx`
  - `glm-4.6`
  - `glm-4.5`
- `v1` also treats z.ai as an always-thinking built-in provider surface, so newly created or switched z.ai sessions land on enabled thinking rather than `off`

## Implemented In `v2`
- expanded `packages/model-catalog` to restore the current `v1` built-in xAI and z.ai chat model sets with matching pricing/max-output metadata
- corrected the lone non-`v1` xAI catalog id in `v2`:
  - old `v2`: `grok-4.20-reasoning`
  - current `v1`: `grok-4.20-beta-0309-reasoning`
- updated workspace/session defaulting so z.ai sessions now initialize with `thinkingMode = "enabled"` and `cacheTtl = "off"` like the current `v1` baseline
- refreshed focused route/runtime coverage to exercise the restored xAI/z.ai model ids instead of the older reduced surface

## Hidden Gaps Found During Re-audit
- the xAI/z.ai surface re-audit exposed two narrower defects:
  - `v2` had drifted to a non-`v1` Grok 4.20 model id, which would have left existing stored rows behind after the selector surface was corrected
  - z.ai sessions still defaulted to `thinkingMode = "off"` even though the shared z.ai runtime always thinks and `v1` treats that provider as enabled by default
- `v2` now fixes both:
  - forward migration `0031_xai_model_id_cleanup.sql` rewrites stored legacy Grok 4.20 ids across sessions, messages, pending assistant rows, campaigns, and wizard runs
  - workspace default routing now enables z.ai thinking on create/model-switch

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- chatRoutes.test.ts workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- the built-in xAI/z.ai chat model surfaces are now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
