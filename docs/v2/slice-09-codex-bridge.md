# Slice 9: Codex Bridge

## Goal
- Restore the admin-only Codex bridge surface from `v1` into `v2` without over-claiming full bridge parity.

## Implemented
- typed `/api/codex/*` proxy routes in `apps/api` for:
  - status/workspaces
  - session list
  - session messages
  - command output fetch
  - upload
  - streaming send
  - interrupt
  - delete
- `apps/api` environment wiring for the managed Codex sidecar:
  - `CODEX_HOST`
  - `CODEX_PORT`
  - `CODEX_SECRET`
  - `CODEX_CA_PATH`
  - `CODEX_SERVERNAME`
- admin-only shell `Codex` dialog in `apps/web`
- dialog support for:
  - choosing a workspace for new threads
  - starting a new thread
  - resuming existing sessions
  - file upload
  - SSE streaming turn output
  - interrupt/delete session controls
  - command-output inspection

## Verification
- `npm test --workspace @tracyhill-rp/api -- codexRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Parity Notes
- This increment closes the Codex half of the previously lumped bridge gap.
- It does **not** yet restore the `v1` Claude Code-specific shell/session flow.
- The parity register and audit now track those as separate bridge sub-surfaces so later work can close the remaining Claude-specific gap honestly.
