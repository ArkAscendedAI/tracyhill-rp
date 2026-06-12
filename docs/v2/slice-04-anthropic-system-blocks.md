# Slice 4 Parity Follow-up: Anthropic System Blocks

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` Anthropic system-prompt block shape for campaign-backed chat dispatch

## `v1` Oracle
- `v1` Anthropic requests do not flatten campaign context into one system string
- `v1` sends campaign `systemPrompt` and `stateSeed` as separate text blocks in the Anthropic `system` array
- each block independently carries cache metadata when Anthropic prompt caching is enabled

## Implemented In `v2`
- updated the shared Anthropic runtime to split `v1`-style campaign prompt payloads back into separate `system` text blocks when the shared chat layer combines them with `\n\n---\n\n`
- preserved cache-control behavior on each restored Anthropic system block instead of collapsing the whole payload into one cache-tagged block
- kept the fix runtime-local so no shared contracts or chat-service call sites had to widen again

## Hidden Gap Found During Re-audit
- after restoring the `v1` non-Anthropic campaign prompt shape, Anthropic still could not match `v1` because the shared runtime was treating the combined campaign prompt as one string and one cache block

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- Anthropic campaign system-block parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
