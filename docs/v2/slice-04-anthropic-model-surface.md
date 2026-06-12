# Slice 4 Parity Follow-up: Anthropic Chat Model Surface

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` built-in Anthropic chat model surface and the Anthropic model-specific runtime defaults that go with it

## `v1` Oracle
- `v1` exposes four built-in Anthropic chat models:
  - `claude-opus-4-6`
  - `claude-sonnet-4-6`
  - `claude-sonnet-4-20250514`
  - `claude-haiku-4-5-20251001`
- `v1` also ties Anthropic defaults to the selected model:
  - Opus 4.6 and Sonnet 4.6 default to `adaptive` thinking
  - Sonnet 4 and Haiku 4.5 default to budgeted thinking
  - Opus 4.6 defaults to `effort = "max"`
  - Sonnet 4.6 defaults to `effort = "high"`
  - thinking budgets default to the model ceiling (`maxOut - 1`)
- when Anthropic thinking is active, `v1` pins `temperature = 1`
- `v1` only sends `output_config.effort` when the resolved effort is not `high`, and only Opus keeps a true `max` effort payload

## Implemented In `v2`
- expanded `packages/model-catalog` to restore the current built-in Anthropic chat models and pricing/cache metadata
- restored Anthropic model metadata for:
  - adaptive-thinking availability on Opus 4.6 and Sonnet 4.6
  - model-specific max thinking budgets
  - effort-option depth, including `max` on Opus 4.6
- changed the shared fallback/default chat model to `claude-opus-4-6` to match the current `v1` oracle
- updated workspace/session defaults so new sessions and Anthropic model switches now use:
  - model-specific `thinkingMode`
  - model-specific thinking budget ceilings
  - model-specific default effort
  - `cacheTtl = "1h"`
- updated campaign/wizard default model fallbacks so newly defaulted operator flows align with the same Anthropic baseline
- corrected the Anthropic runtime to:
  - honor model-specific larger thinking budgets instead of hard-clamping at `4095`
  - set `temperature = 1` while thinking is active
  - omit `output_config` when the resolved effort is `high`
  - preserve `output_config: { effort: "max" }` for Opus 4.6

## Hidden Gaps Found During Re-audit
- the shared Anthropic runtime was still hard-clamping all budgets to `4095`, which would have broken Opus 4.6 and Sonnet 4.6 parity immediately
- the shared Anthropic runtime was also over-sending `output_config` for `high` effort instead of following current `v1` omit-or-downgrade behavior

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts chatRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/worker -- pipelineWorker.test.ts wizardWorker.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- the Anthropic built-in model surface and model-specific default behavior are now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
