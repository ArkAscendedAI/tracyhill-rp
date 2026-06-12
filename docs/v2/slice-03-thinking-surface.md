# Slice 3 Parity Follow-up: Thinking Surface

## Goal
Restore the visible thought/reasoning surface in the normalized `v2` chat path.

## Implemented
- expanded the normalized stream contract with `response.thinking.delta`
- persisted assistant `thinking` text on completed and pending-recovery assistant messages
- taught the shared provider runtime to emit thought deltas where available:
  - OpenAI Responses
  - Anthropic Messages
  - Google Gemini
  - z.ai chat completions
- restored a collapsible thinking block in the conversation pane for both live streaming and completed assistant messages
- preserved thinking text through disconnect recovery so post-reload assistant messages keep the same thought surface

## Notes
- this closes the thinking/thought-presentation portion of Gap 3.2
- a later concurrent-streaming follow-up closed the rest of Gap 3.2

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
