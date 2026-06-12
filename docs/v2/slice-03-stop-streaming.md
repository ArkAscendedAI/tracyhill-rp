# Slice 3 Parity Follow-up: Explicit Chat Stop Streaming

## Goal
- restore the current `v1` explicit stop/abort behavior for active chat streams instead of relying only on browser disconnects

## `v1` Oracle
- `v1` exposes an active-session stop control while a reply is streaming
- `v1` aborts the in-flight provider request instead of continuing token burn after the user explicitly stops
- `v1` persists a visible stopped assistant turn:
  - partial text becomes `...\n\n*[Stopped]*`
  - no text becomes `*[Stopped before response began]*`

## Implemented In `v2`
- added a typed authenticated stop route at `/api/chat/sessions/:sessionId/stream/stop`
- chat service now keeps per-request abort controllers for active streams and aborts the provider runtime on explicit stop
- explicit stop now persists a stopped assistant message with the current `v1` marker shape instead of falling into disconnect-recovery behavior
- restored the conversation-pane stop button while a stream is active
- web stream state now tracks the active request id plus stop intent so intentional stops do not surface as generic send failures

## Hidden Gap Found During Re-audit
- Slice 3 had already restored disconnect recovery and concurrent streaming, but that did not restore explicit user-driven stop parity
- `v2` could survive browser disconnects, yet it still had no real stop route, no active request registry, and no persisted `*[Stopped]*` assistant turn
- the Slice 4 runtime re-audit exposed this because provider abort propagation had been fixed lower in the stack while the chat product surface still had no way to trigger it intentionally

## Verification
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Gap Picture
- explicit chat stop/cancel parity is now restored inside the audited Slice 3 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
