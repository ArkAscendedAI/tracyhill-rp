# Slice 6 Increment: Start Session From Campaign

## Scope
This is the third completed increment inside Slice 6 and closes the slice.

Implemented here:
- session `campaign_id` linkage in SQLite
- campaign `folder_id` linkage in SQLite
- authenticated launch route for creating a new session from an existing campaign
- monotonic `Part N` naming for repeated launches from the same campaign
- campaign-aware session detail payloads for the active conversation pane
- runtime system-prompt wiring so launched sessions use campaign prompt and state-seed context
- web launch action in the campaign panel plus conversation-side campaign context display
- route and browser coverage for launch, linked-session behavior, and normal downstream chat/export/recycle-bin flows

## Notes
- launched sessions keep only `campaign_id`; the full prompt and state-seed remain on the campaign record
- campaign context is resolved on demand for active session detail rather than bloating workspace sidebar state
- campaigns can now optionally own a linked sidebar folder; launch uses that folder when it still exists
- deleting a linked folder clears the campaign's stored `folder_id` so later launches do not point at stale organization state
- Slice 6 is now complete; the next program step is Slice 7 worker-backed pipeline work

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
