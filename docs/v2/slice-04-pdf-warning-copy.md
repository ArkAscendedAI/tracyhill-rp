# Slice 4 Parity Follow-up: PDF Warning Copy

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` PDF warning text on unsupported provider paths

## `v1` Oracle
- current `v1` xAI and z.ai chat requests emit the warning:
  - `[PDF "<name>" attached but not supported by this model — use Anthropic or OpenAI for PDF input]`
- current `v1` does not mention Google in that unsupported-provider warning copy

## Implemented In `v2`
- updated the shared unsupported-PDF warning helper so xAI, z.ai, and other warning-based chat-completions paths now point users only to Anthropic or OpenAI, matching current `v1`
- aligned the remaining punctuation drift too, so the shared warning now uses the same em-dash phrasing as the current `v1` copy instead of a plain hyphen
- updated provider-runtime coverage to pin the corrected warning string on the xAI and z.ai paths

## Hidden Gap Found During Re-audit
- `v2` had drifted from the current `v1` oracle by advertising Google in the unsupported-PDF warning text even though the in-repo `v1` copy no longer does
- a later readback also caught the remaining punctuation mismatch: the shared warning helper was still rendering a hyphen where the current `v1` copy uses an em dash

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- unsupported-PDF warning-copy parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
