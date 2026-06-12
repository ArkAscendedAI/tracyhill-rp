# Slice 3 Parity Follow-up: Session Temperature Control

## Goal
- restore the current `v1` per-session temperature control surface for provider/runtime paths that still honor user temperature

## `v1` Oracle
- `v1` persists `temperature` on sessions with a default of `1`
- `v1` exposes a `Temp` control in chat for:
  - non-reasoning OpenAI chat-completions models
  - xAI chat-completions models
  - Anthropic when thinking is off
  - Gemini when thinking is off
  - custom chat-completions endpoints
- `v1` does not expose or rely on user temperature where the provider path forces another behavior:
  - OpenAI Responses reasoning models
  - z.ai built-in chat
  - active Anthropic thinking
  - active Gemini thinking

## Implemented In `v2`
- added persisted `sessions.temperature` storage with a SQLite migration plus shared contract/schema expansion
- workspace session create/update flows now default temperature to `1`, return it in session summaries/detail, and preserve a user-set value across model switches instead of dropping it
- chat dispatch now forwards persisted session temperature into the shared provider runtime
- shared runtime request builders now emit temperature on the matching non-forced paths:
  - Anthropic when thinking is off
  - OpenAI-compatible chat completions, including xAI and custom chat-completions endpoints
  - Gemini when thinking is off
- restored the `Temp` control in the conversation runtime-controls panel only for the same `v1`-style eligible model paths

## Hidden Gap Found During Re-audit
- this was not just a missing UI knob:
  - `v2` had no persisted session temperature field
  - workspace APIs could not store or update temperature
  - chat dispatch could not forward it
  - eligible provider runtimes therefore always lost a real `v1` runtime control
- the Slice 4 provider re-audit exposed it because provider request-shape comparisons kept assuming a temperature input that `v2` had never restored from the earlier Slice 3 runtime-controls bucket

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Gap Picture
- session temperature control is now restored inside the audited Slice 3 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
