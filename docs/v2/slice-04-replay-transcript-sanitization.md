# Slice 4 Parity Follow-up: Replay Transcript Sanitization

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` replay transcript shape before provider dispatch

## `v1` Oracle
- `v1` does not replay every persisted message verbatim back into provider requests
- before provider dispatch, `v1` excludes persisted meta/error turns such as:
  - `**API Error:**`
  - `**Network Error:**`
  - `**Authentication Error:**`
  - stopped-before-start marker messages
  - response-contained-only-thinking marker messages
- `v1` also strips replay-only transport suffixes from prior assistant turns before sending them back upstream:
  - `\n\n*[Stopped]*`
  - `\n\n---\n\n*[Stream interrupted: ...]*`

## Implemented In `v2`
- extended `apps/api/src/domain/chat/chatService.ts` runtime-message normalization so provider dispatch now:
  - excludes `v1`-style persisted meta/error messages from replay
  - strips stop/interruption transport suffixes from replayed message content
  - still preserves the stored transcript on disk unchanged
- kept this behavior in the shared chat replay path, so all provider runtimes now receive the sanitized conversation shape instead of re-implementing the filter independently

## Hidden Gap Found During Re-audit
- the original concrete mismatch was the stop/interruption suffix replay, but the re-audit exposed a broader hidden defect behind it:
  - `v2` was also replaying persisted transport/meta messages that `v1` intentionally excludes from provider requests
- this meant provider payloads could drift from the real `v1` oracle after earlier interrupted streams or stored upstream-error turns, even when the visible transcript history looked intact to the operator

## Verification
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- replay transcript sanitization is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
