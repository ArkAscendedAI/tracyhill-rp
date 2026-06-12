# Slice 5 Increment: Recycle Bin

## Scope
This is the third completed increment inside Slice 5, not the full slice.

Implemented here:
- soft-delete session lifecycle via `deletedAt`
- authenticated restore and permanent-delete workspace routes
- backend filtering so deleted sessions disappear from active chat and workspace search
- permanent-delete cleanup for session messages, attachments, generated-image rows, and image files
- automatic 30-day recycle-bin purge on workspace load, matching `v1` retention semantics
- recycle-bin UI in the sidebar with restore and permanent-delete actions
- route coverage for delete, restore, hidden-from-search, permanent-delete, and expired-session auto-purge behavior
- browser coverage for the delete and restore flow

## Notes
- normal delete now means move to recycle bin, not immediate erasure
- permanent delete requires the session to already be in the recycle bin
- active-session selection automatically falls back when the active session is soft-deleted
- expired recycle-bin entries are silently purged the next time workspace state is loaded

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
