# Slice 4 Parity Follow-up: Provider Abort Signals

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring abort-signal propagation across the built-in provider runtimes

## `v1` Oracle
- current `v1` provider fetches run under abortable browser requests
- cancel behavior depends on the underlying provider request actually receiving the abort signal

## Implemented In `v2`
- updated the shared Google Gemini, Anthropic, and z.ai chat runtimes so each fetch now forwards `input.signal`
- added focused provider-runtime coverage proving those built-in runtimes now receive an `AbortSignal`
- preserved the existing signal propagation already present on the OpenAI-compatible runtimes

## Hidden Gap Found During Re-audit
- `v2` worker and route layers were already creating abort controllers, but several built-in provider runtimes were still dropping the signal before the fetch call, which would have weakened cancel behavior for those providers

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- provider abort-signal propagation is now restored across the audited built-in chat runtimes
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
