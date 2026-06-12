# Slice 2: Sessions, Folders, Preferences, Sidebar

## Goal
Replace the authenticated placeholder shell with a real workspace sidebar:
- folders persist in SQLite
- sessions persist in SQLite
- active session preference persists in SQLite
- `api` owns sidebar CRUD
- `web` renders and mutates real sidebar state

## Implemented
- shared contracts for workspace state, folders, sessions, and preference updates
- SQLite `folders` and `sessions` tables
- `GET /api/workspace`
- `POST/PATCH/DELETE /api/workspace/folders/:id`
- `POST/PATCH/DELETE /api/workspace/sessions/:id`
- `PATCH /api/workspace/preferences`
- web sidebar shell with:
  - create folder
  - create session
  - rename folder/session
  - collapse folder
  - move session between folder and root
  - in-app delete confirmation
  - active session detail pane

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- deleting a folder unfiles its sessions instead of deleting them
- deleting the active session clears or advances `activeSessionId`
- chat/message persistence is intentionally deferred to Slice 3

## Next Slice
- unified chat contract
- normalized streaming model
- first provider end-to-end
