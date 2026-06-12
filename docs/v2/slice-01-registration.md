# Slice 1 Parity Follow-up: Registration

## Goal
Restore the `v1` public registration path in `v2`, including verification-code confirmation before the account is created.

## Implemented
- shared auth contracts for registration requests and responses
- public `POST /api/auth/register`, `POST /api/auth/register/verify`, and `POST /api/auth/register/resend` routes
- `v1`-style username, email, password, and terms validation
- new `users` columns for `email`, `email_verified`, and `agreed_to_terms`
- pending registration challenges with masked-email display, six-digit verification codes, resend handling, and account creation only after successful verification
- public `/register` and `/register/verify` pages with terms/privacy links and verify-then-sign-in behavior
- duplicate username and duplicate email rejection
- auth email delivery service with SendGrid-backed delivery plus env-gated debug code exposure for local/browser verification
- browser coverage for register, verify, logout, and relogin

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- later Slice 1 work closed the remaining confirmed auth gap through `v1`-style delete-account confirmation depth in `docs/v2/slice-01-account-deletion.md`
