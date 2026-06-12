# Slice 4 Increment: Providers and Session Models

## Scope
This is the third completed increment inside Slice 4, not the full slice.

Implemented here:
- persisted `modelId` on sessions so provider/model choice is part of workspace state
- active-session chat model selection in the web conversation pane
- provider-registry chat runtime dispatch keyed by model catalog metadata
- xAI chat runtime support as the second provider on the unified chat path

## Notes
- the provider surface is still intentionally partial; OpenAI and xAI are the current chat baseline
- image generation remains on the OpenAI-backed path for now
- remaining provider work still includes the rest of the approved chat/image provider set
- session model selection is now durable instead of being implicit frontend state

## Acceptance Evidence
- `npm install`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
