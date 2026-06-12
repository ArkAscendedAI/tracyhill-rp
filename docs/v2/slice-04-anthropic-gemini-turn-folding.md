# Slice 4 Parity Follow-up: Anthropic And Gemini Multimodal Turn Folding

## Goal
- restore the current `v1` provider-local turn folding behavior for consecutive same-role multimodal turns on Anthropic and Gemini

## `v1` Oracle
- `v1` does not use one identical same-role merge rule for every provider
- Anthropic still folds consecutive same-role turns even when one side is multimodal, converting mixed string/array content into one provider message
- Gemini still folds consecutive same-role turns by appending later parts onto the prior `contents[].parts` entry for that role
- OpenAI/xAI/z.ai keep their stricter media-boundary behavior, so this is a provider-local parity rule rather than a shared chat-normalization rule

## Implemented In `v2`
- Anthropic runtime request building now folds consecutive same-role turns the same way `v1` does, including mixed string-plus-multimodal content
- Gemini runtime request building now appends later same-role parts onto the prior `contents` entry like `v1`
- the shared chat normalization layer stays unchanged, so providers that already matched `v1` keep their existing behavior

## Hidden Gap Found During Re-audit
- the earlier media-boundary follow-up fixed the providers that truly preserve media turn boundaries, but it over-generalized that rule across all providers
- current `v1` still performs provider-local multimodal folding on Anthropic and Gemini, so `v2` had drifted on those two providers only

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- Anthropic/Gemini multimodal turn-folding parity is now restored inside the audited Slice 4 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
