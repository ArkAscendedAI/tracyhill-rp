# Slice 4 Parity Follow-up: Google Chat Model Surface

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` built-in Google chat model surface and the Gemini 3.x versus Gemini 2.5 runtime-control split

## `v1` Oracle
- `v1` exposes five built-in Google chat models:
  - `gemini-3.1-pro-preview`
  - `gemini-3-flash-preview`
  - `gemini-3.1-flash-lite-preview`
  - `gemini-2.5-pro`
  - `gemini-2.5-flash`
- `v1` also splits Google thinking configuration by model family:
  - Gemini 3.x uses `generationConfig.thinkingConfig.thinkingLevel`
  - Gemini 2.5 uses `generationConfig.thinkingConfig.thinkingBudget`
- when Google thinking is enabled, `v1` also pins `generationConfig.temperature = 1`

## Implemented In `v2`
- expanded `packages/model-catalog` to restore the five built-in Google chat models and their current `v1` pricing/output metadata
- restored Gemini 3.x runtime-control metadata through `supportsEffort` plus `minimal|low|medium|high` options
- restored Gemini 2.5 Pro-specific max budget metadata (`32768`) instead of reusing the older Flash default
- updated the shared Google runtime to emit:
  - `thinkingLevel` for Gemini 3.x
  - `thinkingBudget` for Gemini 2.5
  - `temperature = 1` whenever Google thinking is active
- updated session-default routing so:
  - Gemini 2.5 models default to enabled thinking with the model-specific budget ceiling
  - Gemini 3.x models default to enabled thinking with `effort = "high"`
- the same strongest-supported defaults now also re-apply on model switch, not just on fresh session creation
- adjusted the web runtime-controls label so Google `supportsEffort` models present `Thinking` / `Thinking level` instead of OpenAI-specific reasoning wording

## Hidden Gap Found During Re-audit
- the first pass exposed an untracked parity defect: newly added `gemini-2.5-pro` would have inherited the older hardcoded `24576` default budget
- `v2` now resolves model-specific Google max-thinking-budget defaults through the model catalog so `gemini-2.5-pro` starts at `32768` like `v1`

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- this follow-up closes the built-in Google chat model surface gap and the Gemini request-shape/runtime-default gap inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
