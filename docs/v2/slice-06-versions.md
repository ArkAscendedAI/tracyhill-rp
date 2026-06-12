# Slice 6 Increment: Version History

## Scope
This is the second completed increment inside Slice 6, not the full slice.

Implemented here:
- SQLite `campaign_versions` table and migration
- archive-on-edit behavior for campaign prompt/seed changes
- authenticated campaign-version list and restore routes
- monotonic current-version advancement when restoring archived content
- web history UI with restore actions inside each campaign card
- route and browser coverage for edit, archive, and restore behavior

## Notes
- campaign name edits alone do not create archived versions
- restore creates a new current version instead of rewinding the campaign counter
- the next Slice 6 step is start-session-from-campaign flow

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
