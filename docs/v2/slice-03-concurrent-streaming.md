# Slice 3 Parity Follow-up: Concurrent Session Streaming

## Goal
Restore the `v1` behavior where one session can keep streaming while the user switches to another session and starts a second stream.

## Implemented
- added a shell-level per-session stream registry in the web app instead of keeping active streaming state only inside the current conversation view
- preserved pending user rows, partial assistant text, and partial assistant thinking per session while the active session changes
- allowed a second session to start streaming without waiting for the first session to finish
- restored sidebar and wizard-slot streaming indicators for sessions with in-flight chat work
- adjusted the mock chat runtime to emit timed deltas so browser coverage exercises real overlapping session streams

## Notes
- this closes the remaining concurrent-streaming portion of Gap 3.2
- Gap 3.2 is now closed

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatRoutes.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
