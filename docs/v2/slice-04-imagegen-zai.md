# Slice 4 Increment: zAI Image Generation

## Scope
This is the ninth completed increment inside Slice 4, not the full slice.

Implemented here:
- zAI image-generation runtime on the shared image path
- GLM Image entry in the shared image model catalog
- registry-based image runtime dispatch extended to zAI
- active-session image model selection now exposes zAI image generation in the web UI

## Notes
- the current image baseline now covers OpenAI, Google, xAI, and zAI
- provider-side chat and image runtime coverage for Slice 4 is now effectively complete
- later Slice 4 follow-ups closed the remaining audited Slice 4 scope, so only Slice 10 cutover work remains confirmed

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
