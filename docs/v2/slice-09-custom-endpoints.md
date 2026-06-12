# Slice 9 Increment: Custom Endpoints

## Goal
Restore the `v1` custom-endpoint surface without claiming unfinished bridge or audit parity.

## Implemented
- extended the existing authenticated `GET /api/provider-keys` and `PUT /api/provider-keys` surface to persist per-user custom endpoints alongside per-user provider keys
- added SQLite-backed `custom_endpoints` storage with:
  - endpoint name
  - base URL
  - auth-header mode
  - API format
  - user-defined model list
- expanded the shell `Provider Keys` dialog so users can:
  - add/edit/delete custom endpoints
  - keep, replace, or clear stored endpoint keys
  - define dynamic model entries with display labels, max output, and context size
- restored `v1`-style dynamic model surfacing from configured endpoints in:
  - the active session chat-model picker
  - campaign pipeline-model selection
  - campaign-panel wizard-model selection
- backend model validation now accepts configured `custom:{endpointId}:{modelId}` ids for:
  - session create/update
  - chat send/stream
  - campaign create/update
  - wizard enqueue/approve
- normalized runtime selection now routes custom models through OpenAI-compatible endpoint execution for:
  - chat
  - pipeline worker execution
  - wizard worker execution
- worker runtime selection no longer relies on a single process-global chat runtime in production-shaped paths; user-scoped provider/custom-endpoint config now reaches queued pipeline and wizard work

## Verification
- `npm test --workspace @tracyhill-rp/api -- providerKeyRoutes.test.ts workspaceRoutes.test.ts chatRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/worker -- pipelineWorker.test.ts wizardWorker.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- this closes the custom-endpoint portion of Slice 9, including dynamic model surfacing from user-defined endpoints
- this increment also closed a newly surfaced parity defect in the worker path: queued pipeline/wizard work now resolves user-scoped runtime config instead of silently falling back to process-global built-in-provider runtime only
- the remaining major Slice 9 work is now:
  - Claude/Codex bridge surface
  - `audit_events` and broader logging completion
