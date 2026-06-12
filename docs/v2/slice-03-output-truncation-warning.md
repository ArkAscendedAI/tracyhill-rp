# Slice 3 Parity Follow-up: Output Truncation Warning

## Goal
- restore the current `v1` visible truncation warning when a chat response hits the model's max output-token limit

## `v1` Oracle
- `v1` normalizes provider-specific finish reasons into a shared truncation signal
- `v1` appends a visible assistant-message warning when output is cut off:
  - `\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit (...)`
- the warning is part of the persisted assistant turn, so it survives reload and later review

## Implemented In `v2`
- shared provider-runtime chat callbacks now surface normalized `outputTruncated` state alongside usage
- OpenAI Responses, OpenAI/xAI/z.ai Chat Completions, Anthropic, and Google Gemini runtimes now detect the current `v1` max-output finish conditions
- chat-service assistant-message persistence now appends the same visible truncation warning when the runtime reports a cutoff
- focused provider-runtime and chat-service coverage now proves both the finish-reason normalization and the persisted warning behavior

## Hidden Gap Found During Re-audit
- `v2` had restored per-model max-output request routing but still dropped provider finish reasons on the chat path
- that meant users could still lose the current `v1` visible cutoff warning even when the runtime had actually hit the model limit

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Gap Picture
- output-truncation warning parity is now restored inside the audited Slice 3 scope
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed
