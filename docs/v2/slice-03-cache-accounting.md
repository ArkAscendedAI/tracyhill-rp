# Slice 3 Parity Follow-up: Cache Accounting And Cache UI

## Goal
Finish the remaining Slice 3 cache parity by persisting Anthropic cache read/write token usage and restoring the cache-derived conversation stats that depend on it.

## Implemented
- expanded normalized chat usage to include `cacheReadTokens` and `cacheWriteTokens`
- persisted cache read/write token usage on assistant messages and pending recovery rows in SQLite
- parsed Anthropic cache read/write usage in `provider-runtime`
- restored cache-aware session stats in the conversation pane:
  - cache read totals
  - cache write totals
  - cache hit rate
  - cache-aware estimated cost
- restored per-message cache usage visibility alongside the existing token and cost line

## Notes
- this closes the remaining cache-accounting portion of Gap 3.3
- Gap 3.3 is now closed
- later parity follow-ups also closed Gap 3.2 through restored thinking surface plus concurrent session streaming

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
