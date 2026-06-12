# Slice 7 Increment: Pipeline Model Runtime

## Scope
This is the third completed increment inside Slice 7, not the full slice.

Implemented here:
- campaign-owned `pipelineModelId` persisted in SQLite and exposed through shared contracts
- campaign-panel pipeline-model selection for create and edit flows
- worker runtime wiring that uses the shared provider-runtime registry when provider keys are available
- deterministic fallback preserved for mock/no-key environments so local verification stays stable
- runtime-backed prompt execution shape for seed, validation, and system-prompt review steps
- route, worker, and browser coverage proving pipeline model selection is visible and carried into run summaries

## Notes
- this increment upgrades Slice 7 from deterministic-only review generation to model-aware execution when configured
- prompt-template parity with `v1` is still outstanding; current prompts are compact `v2` prompts rather than the full legacy campaign-specific template system

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
