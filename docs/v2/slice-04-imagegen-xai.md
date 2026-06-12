# Slice 4 Increment: xAI Image Generation

## Scope
This is the seventh completed increment inside Slice 4, not the full slice.

Implemented here:
- xAI image-generation runtime on the shared image path
- Grok Imagine entry in the shared image model catalog
- registry-based image runtime dispatch instead of assuming OpenAI-only image generation
- active-session image model selection in the web conversation UI

## Notes
- the current image baseline now covers OpenAI and xAI
- Google and zAI image-generation parity are still pending
- generated images still land in the same disk-backed store and SQLite index regardless of provider

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
