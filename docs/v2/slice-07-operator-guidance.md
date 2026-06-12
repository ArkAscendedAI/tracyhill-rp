# Slice 7 Parity Follow-up: Operator Guidance

## Goal
Close the remaining Slice 7 review-depth gap by restoring `v1`-style partial-failure persistence and clearer operator guidance in the pipeline review surface.

## Implemented
- durable pipeline review state now persists fix-generation status/error and fix-apply status/error
- runtime-backed fix generation, fix application, and system-prompt application now fail softly instead of collapsing the whole run
- completed pipeline summaries now call out when manual seed review or manual system-prompt application is still required
- campaign review UI now surfaces explicit validation/system-prompt guidance for pass, auto-fixed, manual-review, and manual-apply states
- system-prompt retry actions now distinguish between rerunning the review and retrying the apply step
- worker coverage now proves partial-failure runs complete with reviewable guidance instead of ending as broad run failures

## Verification
- `npm test --workspace @tracyhill-rp/worker -- pipelineWorker.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Remaining Gap
- Slice 7 review/operator-guidance parity is now closed
