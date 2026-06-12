# Slice 9: Claude Code Bridge

## Goal
- Restore the `v1` Claude Code bridge session flow in `v2` using the same admin-only session/send/stream/status protocol.

## Implemented
- typed `/api/claude-code/*` proxy routes in `apps/api` for:
  - session list
  - session messages
  - session stream subscription with `after`
  - session active/status lookup
  - upload
  - send
  - interrupt
  - delete
- `apps/api` environment wiring for the managed Claude Code sidecar:
  - `CLAUDE_CODE_HOST`
  - `CLAUDE_CODE_PORT`
  - `CLAUDE_CODE_SECRET`
  - `CLAUDE_CODE_CA_PATH`
  - `CLAUDE_CODE_SERVERNAME`
- admin-only shell `Claude Code` dialog in `apps/web`
- dialog support for:
  - new and existing sessions
  - upload/drag-drop attachments
  - send returning a `queryKey`
  - reconnectable SSE streaming with `after` catch-up
  - active-session auto-resume through status lookup
  - interrupt/delete controls
  - tool input/output rendering plus copy actions

## Verification
- `npm test --workspace @tracyhill-rp/api -- claudeCodeRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts`

## Parity Notes
- This increment closes the remaining Claude Code-specific bridge gap inside Slice 9.
- The broader shell/footer placement differences from `v1` still belong to the already-tracked Slice 2/sidebar chrome depth gap rather than bridge functionality itself.
