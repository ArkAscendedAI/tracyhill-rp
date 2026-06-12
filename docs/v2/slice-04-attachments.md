# Slice 4 Increment: Attachments

## Scope
This is the first completed increment inside Slice 4, not the full slice.

Implemented here:
- text-file attachments in the active chat composer
- attachment payloads carried in the unified chat contract
- attachment persistence linked to the user message in SQLite
- attachment metadata rendered back in the conversation history
- GitHub release sidebar seeded for later public-safe export planning

## Notes
- attachment handling is text-first for now (`.txt`, `.md`, `.json`, `.csv`)
- binary/image file handling remains future work
- image generation is still pending in Slice 4
- remaining providers are still pending in Slice 4

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
