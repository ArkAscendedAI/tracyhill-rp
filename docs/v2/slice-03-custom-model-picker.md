# Slice 3 Parity Follow-up: Custom Model Picker

## Goal
Restore the richer `v1` chat-model selection surface without waiting for the remaining cost/cache work.

## Implemented
- replaced the native chat-model `<select>` in the conversation header with a provider-grouped custom picker
- grouped available chat models by provider with expandable provider sections
- preserved outside-click dismissal and current-model highlighting
- kept the existing persisted `modelId` update path so model-switch runtime defaults still flow through the same API behavior
- updated browser coverage to drive the custom picker path instead of the old native select

## Notes
- this closes the custom model picker portion of Gap 3.3
- later cost and cache follow-ups closed the rest of Gap 3.3

## Acceptance Evidence
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
