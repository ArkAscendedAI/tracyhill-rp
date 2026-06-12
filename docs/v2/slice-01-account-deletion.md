# Slice 1 Parity Follow-up: Account Deletion

## Goal
Restore the `v1` destructive-action pattern for account deletion in `v2`: username confirmation, verification-code confirmation, then a distinct final warning before execution.

## Implemented
- shared auth contracts for delete-request, resend, confirm, and execute stages
- authenticated `POST /api/account/delete-request`, `POST /api/account/delete-request/send-code`, `POST /api/account/delete-confirm`, and `DELETE /api/account/delete-execute` routes
- account dialog state machine for username confirmation, sending a delete code, verifying it, and only then exposing the permanent-delete action
- `v1`-style username confirmation gate before any destructive verification code is issued
- `v1`-style final warning stage after verification and before irreversible deletion
- masked-email display, resend handling, attempt limits, expiration, and debug-code exposure for local/browser verification
- last-admin guard matching the `v1` safety rule
- full local user-data cleanup for the deleted user:
  - sessions and messages
  - attachments and pending assistant output
  - generated-image records plus image files
  - folders, campaigns, versions, templates, wizard/pipeline runs, preferences, and the user row
- session destruction plus trust-cookie clearing after successful deletion
- browser coverage for the staged delete flow and last-admin guard path

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- this increment closes the remaining confirmed Slice 1 delete-account UX gap inside the audited scope
