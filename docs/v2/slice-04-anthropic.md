# Slice 4 Increment: Anthropic Chat Runtime

## Scope
This is the fourth completed increment inside Slice 4, not the full slice.

Implemented here:
- Anthropic Messages API runtime on the unified chat path
- Anthropic model entry in the shared model catalog
- API bootstrap support for `ANTHROPIC_API_KEY`
- default session chat model moved to the Anthropic baseline model

## Notes
- the current text-chat baseline is now Anthropic, OpenAI, and xAI
- image generation remains on the OpenAI-backed path for now
- remaining provider work still includes the rest of the approved chat/image provider set
- the persisted session-model path added in the prior increment is reused unchanged

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
