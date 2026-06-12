# Slice 3 Parity Follow-up: Cache TTL Control

## Goal
Restore the `v1` Anthropic cache TTL operator control in `v2` without overstating the still-missing cache accounting surface.

## Implemented
- added durable session-level `cacheTtl` storage in SQLite and shared workspace contracts
- restored Anthropic-default cache TTL behavior for new sessions and model switches back to Anthropic
- reset cache TTL to `off` for models that do not support prompt caching
- wired the Anthropic runtime to emit `cache_control` on the session system prompt for `5m` and `1h`
- added a conversation-pane cache TTL control for Anthropic sessions

## Notes
- this closes the cache TTL control portion of Gap 3.3
- later cache-accounting follow-up closed the rest of Gap 3.3
- this increment intentionally does not claim cache usage parity; `v2` still lacks persisted cache-read/cache-write token accounting and derived hit-rate UI

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
