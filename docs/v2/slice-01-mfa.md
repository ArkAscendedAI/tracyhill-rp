# Slice 1 Parity Follow-up: MFA Challenge

## Goal
Restore the first `v1` MFA layer in `v2`: a second-step sign-in code challenge for verified-email users after password login succeeds.

## Implemented
- shared auth contracts for MFA login challenges plus resend and verify routes
- authenticated email-code challenge issuance during login for users with verified email and available auth-email delivery
- pending MFA challenges with masked-email display, resend handling, attempt limits, expiration, and debug-code exposure for local/browser verification
- public `POST /api/auth/mfa/resend` and `POST /api/auth/mfa/verify` routes
- authenticated `GET /api/account/mfa` route exposing current email-MFA status plus remembered-device inventory
- public `/mfa` page with verify, resend, cancel, and post-login session completion behavior
- account dialog MFA status section showing whether email MFA is active for the current account
- login-shell wiring that persists the pending MFA challenge client-side and redirects into the second-step flow
- browser coverage for register, verify, logout, login, MFA verify, workspace entry, and account-side MFA status rendering

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- subsequent Slice 1 re-audit narrowed the remaining auth gap to delete-account confirmation depth, which is now closed in `docs/v2/slice-01-account-deletion.md`
