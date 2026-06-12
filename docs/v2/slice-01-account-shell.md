# Slice 1 Parity Follow-up: Account Shell

## Goal
Restore the higher-level `v1` account-management shell shape in `v2` so password, MFA, and destructive account actions are surfaced as distinct authenticated entry points instead of one combined dialog.

## Implemented
- dedicated authenticated password dialog in the workspace shell
- dedicated authenticated MFA dialog showing account-side MFA status plus trusted-device management
- dedicated authenticated delete-account dialog for the staged destructive flow
- shell button wiring for separate `Password`, `MFA`, and `Delete Account` actions beside logout
- public legal-page copy updated so it no longer claims already-restored auth flows are still missing
- browser coverage updated to drive the distinct password, MFA, and delete-account entry points

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- subsequent Slice 1 re-audit narrowed the remaining auth gap to delete-account confirmation depth, which is now closed in `docs/v2/slice-01-account-deletion.md`
