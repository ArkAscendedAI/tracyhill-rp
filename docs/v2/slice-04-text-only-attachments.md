# Slice 4 Parity Follow-up: Text-Only Attachment Request Shape

## Goal
- restore the current `v1` provider-request shape for turns that carry only text attachments

## `v1` Oracle
- `v1` serializes text-only attachments into plain text before provider dispatch
- `v1` only switches to structured multimodal arrays or parts when an image or PDF is actually present
- this applies across the current built-in provider paths, not just OpenAI Responses

## Implemented In `v2`
- shared provider-runtime builders now keep text-only attachment turns on their plain-text path
- Anthropic, OpenAI Responses, OpenAI/xAI/z.ai Chat Completions, and Google Gemini now only build structured multimodal payloads when a binary/image/PDF attachment is present
- focused provider-runtime coverage now proves text-only attachment turns stay plain text across those built-in provider paths

## Hidden Gap Found During Re-audit
- the earlier attachment parity work restored native image/PDF handling, but it still over-materialized text-only attachments into structured multimodal payloads
- that meant `v2` could diverge from the current `v1` request shape even when no binary content was present

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- text-only attachment request-shape parity is now restored inside the audited Slice 4 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
