# Slice 3 Parity Follow-up: Runtime Controls And Prompt Templates

## Goal
Close the next unblocked Slice 3 parity gap by restoring more of the `v1` chat operator surface without taking on the still-larger disconnect-recovery rewrite.

## Implemented
- persisted per-session runtime settings in SQLite:
  - `thinkingMode`
  - `thinkingBudget`
  - `effort`
  - `autoScroll`
  - `cacheTtl` remains a later follow-up in this timeline and was restored separately
- message usage persistence in SQLite:
  - `inputTokens`
  - `outputTokens`
  - `totalTokens`
- provider-runtime wiring for session-selected thinking and effort controls where supported
- active conversation stats for:
  - total tokens
  - input/output totals
  - per-message token usage
- per-user prompt-template domain in SQLite with authenticated CRUD routes
- conversation-pane prompt-template modal with:
  - create
  - edit
  - delete
  - `Use` action that injects the template as a text attachment chip

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- promptTemplateRoutes.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- later parity increments restored cache TTL plus cache read/write accounting, so Gap 3.3 is now closed
- this increment narrows Gap 3.3, but does not fully close it
- later parity increments also restored disconnect recovery, thinking surface, and concurrent session streaming, so Gap 3.2 is now closed
- a later post-parity follow-up tightened session create/model-switch defaults so the strongest supported thinking/cache settings are re-applied automatically when a user switches models:
  - Anthropic keeps `cacheTtl = "1h"` plus model-specific thinking defaults
  - Gemini 2.5 starts at the model budget ceiling
  - Gemini 3.x starts at `effort = "high"`
  - OpenAI reasoning models now start at the highest supported effort from the shared model catalog instead of the older hardcoded `medium`
- a later post-parity follow-up also added a context-aware soft warning in the conversation model picker:
  - it estimates the current persisted session context from campaign docs plus loaded transcript content
  - it only warns when that existing context already appears larger than the selected model's stored `ctx`
  - it does not hard-block model switches or sends because `v2` still lacks a tokenizer-based built-in context guard
