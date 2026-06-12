# Slice 7 Increment: Pipeline Queue Foundation

## Scope
This is the first completed increment inside Slice 7, not the full slice.

Implemented here:
- SQLite `pipeline_runs` table and migration
- authenticated enqueue and list routes for campaign pipeline runs
- worker-side run claiming and terminal status transitions
- mock-mode inline worker kick for local tests and browser verification
- campaign-panel `Run Pipeline` action plus latest-run status card with polling
- route, worker, and browser coverage for the new queue path

## Notes
- this is queue/worker scaffolding only; it does not implement the full v1 multi-step pipeline yet
- completed runs currently emit a deterministic scaffold summary rather than real seed/system-prompt outputs
- the next Slice 7 step is real multi-step pipeline execution plus approval/review state

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
