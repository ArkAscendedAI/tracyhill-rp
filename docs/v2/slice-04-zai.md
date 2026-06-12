# Slice 4 Increment: zAI Chat Runtime

## Scope
This is the fifth completed increment inside Slice 4, not the full slice.

Implemented here:
- zAI chat-completions runtime on the unified chat path
- GLM-5 model entry in the shared model catalog
- API bootstrap support for `ZAI_API_KEY`
- active-session model selection now exposes zAI through the existing session-model flow

## Notes
- the current text-chat baseline is now Anthropic, OpenAI, xAI, and zAI
- image generation is still only implemented on the OpenAI-backed path
- remaining provider work is now concentrated on Google plus multi-provider image generation parity
- the zAI runtime currently normalizes text deltas only; richer provider-specific reasoning surfaces remain out of scope for this slice increment

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
