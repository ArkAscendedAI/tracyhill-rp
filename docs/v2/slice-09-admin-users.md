# Slice 9 Increment: Admin User Management

## Goal
Restore the `v1` admin user-management surface as a bounded Slice 9 increment without claiming unfinished custom-endpoint, bridge, or audit parity.

## Implemented
- added admin-only `GET /api/admin/users`
- added admin-only `POST /api/admin/users`
- added admin-only `DELETE /api/admin/users/:userId`
- added admin-only `PUT /api/admin/users/:userId/password`
- added admin-only `PUT /api/admin/users/:userId/role`
- added admin-only session-inspection routes:
  - `GET /api/admin/users/:userId/sessions`
  - `GET /api/admin/users/:userId/sessions/:sessionId`
- added shell-level `Users` dialog for admin users
- admin dialog now supports:
  - user list
  - create user
  - reset password
  - delete user with in-app confirmation
  - role toggle protection against editing your own role
  - per-user session list
  - per-session message inspection

## Verification
- `npm test --workspace @tracyhill-rp/api -- adminRoutes.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- this closes the admin user-management portion of the Slice 9 gap
- the remaining major Slice 9 work is still:
  - custom endpoints and dynamic model surfacing
  - Claude/Codex bridge surface
  - `audit_events` and broader logging completion
- browser coverage currently proves the shell dialog opens and creates users; the deeper reset/delete/role/session-inspection behaviors are covered through API integration tests
