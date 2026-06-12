# Slice 6 Increment: Campaigns

## Scope
This is the first completed increment inside Slice 6, not the full slice.

Implemented here:
- SQLite `campaigns` table and migration
- shared campaign contracts for list/create/update
- authenticated campaign CRUD routes in `apps/api`
- route coverage for create, update, delete, and default `version = 1`
- web campaign panel with create, inline edit, and delete flows
- browser coverage proving campaign creation inside the workspace shell

## Notes
- this increment is groundwork only; version history is not implemented yet
- campaign start-session flow is not implemented yet
- the next Slice 6 step is version history plus launch flow from an existing campaign

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
