# Slice 3 Parity Follow-up: Disconnect Recovery

## Goal
Restore the `v1` browser-disconnect safety net.

## Implemented
- durable `pending_assistant_messages` persistence in SQLite
- chat stream handling that continues upstream model work after the browser disconnects
- pending assistant output saved durably instead of being dropped when the response stream loses its client
- idempotent merge of pending assistant output into the real session message history on the next session load
- session/sidebar refresh wiring so merged recovery output updates the workspace shell after reload
- cleanup of pending recovery rows when sessions are deleted or wizard-source sessions are discarded/approved away

## Notes
- this closes the disconnect-recovery and pending-message-merge portion of Gap 3.2
- a later concurrent-streaming follow-up closed the rest of Gap 3.2
- the recovery path intentionally preserves `v1` semantics:
  - user message persists before provider execution
  - server continues the upstream request after browser disconnect
  - assistant output merges safely once on the next load

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
