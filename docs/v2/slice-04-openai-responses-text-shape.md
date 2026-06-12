# Slice 4 Parity Follow-up: OpenAI Responses Plain-Text Shape

## Goal
- narrow the remaining Slice 4 provider-behavior gap by restoring the current `v1` OpenAI Responses request shape for attachment-free turns

## `v1` Oracle
- `v1` OpenAI Responses requests keep plain-text turns as raw strings when a message has no attachments
- `v1` only switches a turn to structured `input_text` / `input_image` / `input_file` arrays when attachments are actually present

## Implemented In `v2`
- updated the shared OpenAI Responses runtime so attachment-free turns now stay raw strings instead of being wrapped in a one-item `input_text` array
- kept the existing structured array behavior for turns that include attachments
- added focused provider-runtime coverage proving plain-text Responses turns now preserve the current `v1` shape

## Hidden Gap Found During Re-audit
- `v2` was still wrapping attachment-free OpenAI Responses turns in `[{ type: "input_text", text: ... }]`, which did not match the current in-repo `v1` builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- OpenAI Responses plain-text request-shape parity is now restored inside the audited scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
