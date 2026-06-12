# Slice 3 Parity Follow-up: Cost Visibility

## Goal
Restore the `v1` chat cost surface on top of the already-persisted token-usage metadata without claiming cache parity that `v2` does not yet support.

## Implemented
- extended `packages/model-catalog` chat metadata with per-model input and output token pricing for the shipped `v2` chat catalog
- added session-level estimated cost visibility in the conversation detail stats
- added per-message estimated cost visibility alongside the existing input/output/total token counters
- kept cost rendering estimate-only and usage-driven so messages without usage or pricing metadata degrade cleanly instead of showing incorrect totals

## Notes
- this closes the cost-visibility portion of Gap 3.3
- later cache follow-ups closed the rest of Gap 3.3
- this increment intentionally does not claim cache parity; `v2` still lacks provider cache-read/cache-write persistence and cache-storage accounting

## Acceptance Evidence
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
