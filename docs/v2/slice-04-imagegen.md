# Slice 4 Increment: Image Generation

## Scope
This is the second completed increment inside Slice 4, not the full slice.

Implemented here:
- unified image-generation request contract shared by `api` and `web`
- SQLite indexing for generated images linked to assistant messages
- disk-backed image storage with API serving by generated image ID
- OpenAI-backed image runtime plus mock runtime coverage for automated tests
- active-session image generation from the web conversation pane

## Notes
- current image generation coverage is intentionally narrow: one shared image path, one initial model entry, one provider implementation
- generated images are stored on disk and indexed from SQLite rather than embedded in message rows
- attachment and image rendering now coexist on the same conversation detail path
- remaining chat providers are still pending in Slice 4

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
