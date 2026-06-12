# Slice 7 Increment: Pipeline Review and Approval

## Scope
This is the second completed increment inside Slice 7, not the full slice.

Implemented here:
- step-level pipeline review state persisted on `pipeline_runs`
- deterministic worker execution for seed draft, validation report, and system-prompt draft generation
- authenticated pipeline-approval route that promotes a completed run into the campaign record
- automatic campaign version archival before approval writes the new seed/system prompt
- optional approval-time session launch using the same campaign session flow as the main workspace
- campaign-panel review UI with step cards, draft visibility, `Approve Draft`, and `Approve + Start Session`
- route, worker, and browser coverage for review plus approval-side-effect launch behavior

## Notes
- this increment establishes the durable review/approval loop but still uses deterministic draft generation rather than full provider-backed parity with `v1`
- approval-time session launch now restores the major downstream RP side effect from `v1`, but active-run discovery, cancel, and stage-specific retry parity are still future work

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
