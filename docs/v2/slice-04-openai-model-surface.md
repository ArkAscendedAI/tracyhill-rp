# Slice 4 Parity Follow-up: OpenAI Chat Model Surface

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` built-in OpenAI chat model surface and the OpenAI Responses-versus-Chat-Completions transport split

## `v1` Oracle
- `v1` exposes nine built-in OpenAI chat models:
  - `gpt-5.4`
  - `gpt-5`
  - `gpt-5-mini`
  - `gpt-5-nano`
  - `o4-mini`
  - `o3`
  - `gpt-4.1`
  - `gpt-4.1-mini`
  - `gpt-4.1-nano`
- `v1` also splits OpenAI runtime routing by model family:
  - reasoning-capable models use the Responses API path
  - the `gpt-4.1*` family uses the Chat Completions path
- `v1` keeps native image/PDF payloads on the OpenAI chat-completions path rather than degrading them into warning text

## Implemented In `v2`
- expanded `packages/model-catalog` to restore the current built-in OpenAI chat model set and its `v1` pricing/output metadata
- marked the reasoning-capable OpenAI models with `supportsEffort` metadata so the shared runtime can distinguish Responses-path models from the non-reasoning `gpt-4.1*` family
- added a dedicated built-in OpenAI chat-completions runtime wrapper and changed the runtime registry to route:
  - `gpt-5.4`, `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o4-mini`, and `o3` through OpenAI Responses
  - `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` through Chat Completions
- restored native OpenAI chat-completions multimodal payloads for images and PDFs while keeping streamed usage enabled on that path
- updated focused API coverage so current OpenAI model ids are exercised instead of the removed `gpt-5.4-mini` baseline
- tightened workspace/session defaults so new sessions and model switches now use the strongest supported OpenAI effort from the shared model catalog instead of the older hardcoded `medium`

## Hidden Gap Found During Re-audit
- the OpenAI re-audit exposed a stale DB/default mismatch that was no longer valid against the current `v1` oracle:
  - the historical `sessions.model_id` migration default still pointed at `gpt-5.4-mini`
  - the shared schema metadata also lacked the current default-model fallback
- `v2` now fixes that forward with:
  - a new migration that rebuilds `sessions` with `model_id DEFAULT 'claude-opus-4-6'`
  - matching Drizzle schema metadata so fresh DB-backed inserts align with the current shared default baseline

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- chatRoutes.test.ts workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- the built-in OpenAI chat model surface and transport split are now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
