# Slice 1 Parity Follow-up: Trusted Devices

## Goal
Restore the `v1` trusted-device layer in `v2` so an MFA-verified browser can be remembered, later password logins on that browser can bypass the second step, and users can revoke saved devices from the account UI.

## Implemented
- durable `users.trusted_devices` persistence for remembered MFA devices
- trusted-device cookie issuance after MFA verification when the user opts into remembering the browser
- password-login bypass when the trusted-device cookie matches a still-valid saved device
- account routes for listing, revoking one, and revoking all trusted devices
- account dialog UI showing remembered devices with revoke actions
- trust-cookie clearing on logout and account deletion, matching the `v1` behavior model
- password-reset invalidation of all trusted devices for the account
- route and browser coverage proving trust, reuse, and revocation behavior

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Re-audit Note
- current in-repo `v1` no longer exposes the older SMS/method-switch branches that earlier auth docs had still been carrying forward
- subsequent Slice 1 re-audit narrowed the remaining auth gap to delete-account confirmation depth, which is now closed in `docs/v2/slice-01-account-deletion.md`
