# Slice 4 Parity Follow-up: Media Turn Boundaries

## Goal
- restore the current `v1` provider-request shape for consecutive same-role turns when attachments are present

## `v1` Oracle
- `v1` coalesces consecutive same-role turns only when the provider payload is still plain text on both sides
- `v1` keeps media-bearing user turns as separate provider messages instead of flattening their attachments into one combined turn
- later plain-text same-role turns can still coalesce after an earlier media-bearing turn boundary

## Implemented In `v2`
- chat runtime normalization now coalesces consecutive same-role turns only when neither side carries attachments
- attachment-bearing user turns now stay as separate provider messages
- later text-only user turns still merge where `v1` would merge them

## Hidden Gap Found During Re-audit
- the earlier Slice 4 normalization fix correctly restored coalescing for adjacent text turns, but it overreached by also merging attachment-bearing user turns
- that meant `v2` could still change provider request shape on multimodal conversations even after the attachment-context parity work had landed

## Verification
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Gap Picture
- media-bearing turn-boundary parity is now restored inside the audited Slice 4 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
