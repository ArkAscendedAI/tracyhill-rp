# Slice 7 Increment: Auto-Fix and Retry

## Scope
This is the fifth and final completed increment inside Slice 7.

Implemented here:
- validation pass/fail parsing persisted on pipeline runs
- stored auto-fix output including surgical fix notes and fixed-state-seed review material
- approval flow now prefers the fixed state seed when validation fails and auto-fix succeeds
- authenticated retry route for rerunning a prior pipeline run
- stage-specific retry modes for validation, fix-only, and system-prompt reruns using persisted prior-run output
- persisted retry lineage metadata including both source run ID and retry mode
- campaign-panel retry action plus richer review rendering for validation/fix output
- route, worker, and browser coverage for auto-fix and retry behavior

## Notes
- Slice 7 is now complete as a worker-backed pipeline baseline for `v2`
- stage-specific retry parity is now restored; the remaining major pipeline operator gaps are active-run discovery and cancel/abort control parity
- the next program step is Slice 8: worker-backed wizard

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
