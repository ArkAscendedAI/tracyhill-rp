# v2 Logging And Audit

## Operational Logs
- structured JSON
- emitted to stdout
- shared logger from `packages/logging`
- correlation IDs for requests and jobs
- no secrets, prompts, full messages, or attachment payloads by default

## Audit Events
- DB-backed `audit_events`
- separate from operational logs
- used for security-sensitive and operator-sensitive actions
- admin review route and shell dialog now exist for recent-event inspection

## Required Context
- request ID
- job ID when applicable
- user ID when applicable
- session/campaign/run IDs when applicable

## Default Retention Posture
- enforce hard caps with Docker logging options (`json-file` driver)
- defaults (overridable via `DOCKER_LOG_MAX_SIZE` / `DOCKER_LOG_MAX_FILE`):
  - `max-size=10m`
  - `max-file=5`

## Implemented Audit Coverage
- account password change, trusted-device revoke, and staged account deletion
- admin storage reads, image purge, and admin user-management actions
- provider-key and custom-endpoint updates
- pipeline and wizard enqueue/approve/retry/cancel flows
- Codex and Claude Code upload/send/interrupt/delete flows

## Rollout
- Slice 1: logger package, request IDs, startup/auth logging
- Slice 2: sidebar/session/folder CRUD travels through request-correlated API logs
- Slice 3: chat requests carry request correlation through API and first-provider runtime
- Slice 7: worker/job logging, pipeline audit
- Slice 8: wizard audit
- Slice 9: admin/provider/custom-endpoint/bridge audit complete, with account-side security actions folded into the same audit surface during implementation
- Slice 10: retention and redaction verification
