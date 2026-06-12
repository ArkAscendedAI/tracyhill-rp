# Slice 4 Parity Follow-up: Runtime Conversation Normalization

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` runtime conversation shape before provider dispatch

## `v1` Oracle
- `v1` does not forward the raw persisted message list directly to provider builders
- before provider dispatch, `v1` coalesces consecutive same-role turns into a single runtime message
- when adjacent user turns are merged, `v1` preserves attachment context in order instead of dropping or reordering attachments across the merged runtime block

## Implemented In `v2`
- updated `apps/api/src/domain/chat/chatService.ts` so runtime dispatch now normalizes the conversation assembled from persisted messages plus the just-submitted user turn
- consecutive `user` or `assistant` messages now merge into a single runtime message before calling `runtime.streamChat(...)`
- merged runtime messages now preserve:
  - message content in conversation order using `\n\n` separation
  - attachment arrays in their original order across merged user turns
- the persisted message store remains unchanged; the normalization is a provider-dispatch correction only

## Hidden Gap Found During Re-audit
- the broader Slice 4 “provider-specific request-shape differences” bucket hid a concrete transport defect:
  - `v2` persisted and replayed the correct conversation history
  - but it still sent raw consecutive same-role turns to the shared provider runtime instead of the coalesced runtime shape used by current `v1`
- this mattered most in edit-heavy or resumed conversations, where provider payload shape could drift from the real `v1` oracle even though the visible chat transcript looked correct

## Verification
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- runtime conversation normalization is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
