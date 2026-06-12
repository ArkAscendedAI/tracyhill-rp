# Slice 4 Parity Follow-up: Gemini Thinking Disable Shape

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` Gemini 2.5 request shape when thinking is turned off

## `v1` Oracle
- `v1` Gemini 2.5 requests only send `generationConfig.thinkingConfig` when thinking is enabled
- when Gemini thinking is off, `v1` omits `thinkingConfig` entirely instead of forcing a `thinkingBudget: 0` payload
- when thinking is off, `v1` still forwards user temperature on the Gemini path

## Implemented In `v2`
- updated the shared Gemini runtime so Gemini 2.5 omits `generationConfig.thinkingConfig` entirely when `thinkingMode === "off"`
- preserved explicit temperature forwarding on the Google runtime path when thinking is disabled
- aligned the provider-runtime unit coverage with the real `v1` off-state request shape

## Hidden Gap Found During Re-audit
- `v2` was still forcing `thinkingConfig: { thinkingBudget: 0 }` on Gemini 2.5 when thinking was off, which did not match the current in-repo `v1` builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- Gemini thinking-disable request-shape parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
