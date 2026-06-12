# Slice 1 Parity Follow-up: Forgot Password

## Goal
Restore the `v1` username-based forgot-password flow in `v2` with emailed verification codes and a follow-on password reset step.

## Implemented
- shared auth contracts for forgot-password request, resend, verify, and reset routes
- public `POST /api/auth/forgot-password`, `POST /api/auth/forgot-password/resend`, `POST /api/auth/forgot-password/verify`, and `POST /api/auth/forgot-password/reset` routes
- generic request response to avoid straightforward username enumeration
- pending password-reset challenges with masked-email display, six-digit verification codes, resend handling, and a verified-reset stage before password change
- public `/forgot-password` page covering request, verify, and reset states
- auth email delivery reuse through the shared SendGrid/debug-code auth-mail service
- browser coverage proving register, logout, forgot-password reset, and relogin with the new password

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- later Slice 1 work closed the remaining confirmed auth gap through `v1`-style delete-account confirmation depth in `docs/v2/slice-01-account-deletion.md`
