# Slice 4 Parity Follow-up: Provider Max Output Routing

## Scope
This parity follow-up restores a provider-routing detail that `v1` already handled per model but `v2` had still been hardcoding or omitting on several runtime paths.

Implemented here:
- shared built-in chat model metadata now carries per-model max output token limits
- built-in model resolution no longer collapses `maxOut` to a generic `4096`
- Anthropic runtime now sends model-specific `max_tokens`
- OpenAI Responses runtime now sends model-specific `max_output_tokens`
- Google Gemini runtime now sends model-specific `generationConfig.maxOutputTokens`
- xAI and zAI runtimes now send model-specific `max_tokens`
- xAI and zAI runtimes now request streamed usage metadata again
- custom endpoint chat runtimes now forward configured `maxOut` limits into downstream runtime requests

## Notes
- this follow-up narrows Slice 4 by restoring per-model output-limit routing rather than changing the product surface
- the remaining Slice 4 provider gap is now broader reasoning/routing nuance, not missing max-output configuration on the current model set

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm test`
- `npm run build`
