# Slice 6 Parity Follow-up: Campaign Runtime Prompt Shape

## Scope
This follow-up closes a hidden campaign-runtime parity gap exposed during the provider-behavior re-audit.

Implemented here:
- `v1`-style non-Anthropic campaign context shaping for chat runtime dispatch
- removal of invented `Campaign System Prompt` / `Campaign State Seed` headings from the combined runtime `systemPrompt`
- exact `systemPrompt + "\n\n---\n\n" + stateSeed` joining when both campaign documents exist
- focused chat-service coverage proving campaign-backed sessions send the expected upstream `systemPrompt`

## Notes
- this changes only the provider payload shape used for campaign-backed chat requests
- persisted campaign/session data is unchanged
- wizard sessions still use their dedicated wizard-session prompt builder
- the gap belonged to Slice 6 because it was campaign context wiring, not a generic provider-surface problem

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
