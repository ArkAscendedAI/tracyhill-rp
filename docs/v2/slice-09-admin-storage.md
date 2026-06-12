# Slice 9 Increment: Admin Storage And Image Operations

## Goal
Restore the `v1` admin storage modal and image-purge surface as a bounded Slice 9 increment without claiming unfinished admin user-management, custom-endpoint, bridge, or audit parity.

## Implemented
- added admin-only `GET /api/admin/storage`
- added admin-only `DELETE /api/admin/images`
- added shell-level `Storage` dialog for admin users
- storage dialog now shows:
  - disk total
  - disk used
  - disk free
  - generated-image count and bytes
  - user-data bytes
  - total app-data bytes
- image purge now deletes:
  - generated image files from disk
  - generated-image rows from SQLite
  - generated-image references from session detail after query refresh
- purge uses an in-app destructive confirmation state rather than browser `confirm()`

## Verification
- `npm test --workspace @tracyhill-rp/api -- adminRoutes.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- this closes the storage/image-admin portion of the Slice 9 gap
- the remaining major Slice 9 work is still:
  - custom endpoints and dynamic model surfacing
  - Claude/Codex bridge surface
  - `audit_events` and broader logging completion
- current storage accounting is intentionally app-local:
  - disk stats come from the configured data target
  - user-data bytes currently reflect the SQLite database files
  - generated images are counted from the configured image store
