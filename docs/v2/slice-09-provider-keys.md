# Slice 9 Increment: Provider Keys

## Goal
Restore the `v1` per-user provider-key surface as the first bounded Slice 9 increment without claiming unfinished admin, custom-endpoint, bridge, or audit parity.

## Implemented
- added SQLite-backed per-user `provider_keys` storage
- added authenticated `GET /api/provider-keys` and `PUT /api/provider-keys`
- added shell-level `Provider Keys` dialog for:
  - Anthropic
  - OpenAI
  - Google
  - xAI
  - z.ai
- status rendering now distinguishes:
  - stored user override
  - server fallback
  - not configured
- stored per-user keys now drive runtime selection for:
  - chat
  - image generation
  - pipeline worker execution
  - wizard worker execution
- runtime selection now prefers the user-owned key for a provider and falls back to the server env key only when the user has not stored an override

## Verification
- `npm test --workspace @tracyhill-rp/api -- providerKeyRoutes.test.ts providerKeyRuntime.test.ts chatRoutes.test.ts imageRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/worker -- pipelineWorker.test.ts wizardWorker.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Notes
- this closes the provider-key portion of the Slice 9 gap
- the remaining major Slice 9 work is still:
  - Claude/Codex bridge surface
  - `audit_events` and broader logging completion
- the current provider-key surface intentionally exposes status and replacement flow rather than echoing raw stored secrets back into the browser
