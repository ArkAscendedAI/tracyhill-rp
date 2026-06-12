# Slice 1 Parity Follow-up: Password And Legal

## Goal
Restore the first product-facing auth/account behaviors from `v1` without pulling in the larger MFA and registration surface:
- public privacy and terms pages
- authenticated self-service password change

## Implemented
- shared auth contracts for password-change requests and responses
- API password-change route under `/api/account/password`
- current-password verification plus `v1`-style password complexity validation
- authenticated account dialog in the app shell for password change
- public `/terms` and `/privacy` pages reachable from the login and account surfaces
- browser coverage for legal-page reachability plus password change and relogin

## Verification
- `npm test --workspace @tracyhill-rp/api -- authRoutes.test.ts authService.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Remaining Gap
- broader MFA parity beyond the restored email plus trusted-device flow
- broader account-management parity beyond the currently restored password, registration, forgot-password, and delete flows
