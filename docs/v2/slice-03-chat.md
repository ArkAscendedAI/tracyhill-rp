# Slice 3: Unified Chat, Normalized Streaming, First Provider

## Goal
Turn an active session into a real conversation surface:
- persist messages in SQLite
- expose a unified chat detail contract
- expose a normalized streaming contract
- wire the first provider end-to-end

## Implemented
- shared chat contracts:
  - session detail response
  - send-message request
  - normalized stream events
- SQLite `messages` table
- `packages/model-catalog` with first chat model metadata
- `packages/provider-runtime` with:
  - OpenAI Responses runtime
  - mock echo runtime for automated verification
- `GET /api/chat/sessions/:id`
- `POST /api/chat/sessions/:id/stream`
- web conversation pane with:
  - message history
  - composer
  - live streaming text
  - browser-disconnect recovery with durable pending assistant output and merge-on-load behavior
  - provider-grouped custom chat model picker
  - context-aware soft warning when the selected model appears smaller than the already persisted session context
  - persisted runtime controls:
    - thinking mode
    - thinking budget
    - effort
    - cache TTL
    - auto-scroll
  - token visibility:
    - session totals
    - input/output totals
    - per-message usage
  - estimated cost visibility:
    - session totals
    - per-message estimates
  - cache accounting visibility:
    - cache read totals
    - cache write totals
    - cache hit rate
    - per-message cache usage
  - per-user prompt templates with text-attachment injection
  - post-send workspace/session refresh
  - message lifecycle controls:
    - edit
    - resend
    - regenerate
    - cut-after
    - delete
    - copy
    - long-message dual action bars
  - typed mutation routes:
    - `PUT /api/chat/sessions/:id/messages/:messageId`
    - `DELETE /api/chat/sessions/:id/messages/:messageId`
    - `POST /api/chat/sessions/:id/messages/truncate`

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Notes
- user messages persist before provider execution
- assistant messages persist immediately after successful completion when the browser stays connected
- if the browser disconnects mid-stream, assistant output now persists durably as pending recovery state and merges idempotently on the next session load
- mock provider is used in automated browser coverage
- OpenAI key handling is env-based for this slice; per-user provider key management remains later work
- replay actions now truncate/delete persisted history before re-sending so `Resend` and `Regen` match the `v1` conversation semantics more closely
- runtime defaults now reset on model switch based on the selected model’s supported controls
- prompt templates intentionally use the existing attachment path so template usage is preserved in exported/persisted messages instead of being silently injected into the draft
- chat model selection now uses a provider-grouped custom picker instead of a native `<select>`, matching the broader `v1` interaction pattern more closely
- cost visibility now derives from persisted token usage plus shared model-catalog pricing metadata; cache-derived cost/accounting remains intentionally deferred
- Anthropic cache TTL now persists per session and flows into the runtime request shape on supported models only
- Anthropic cache read/write usage now persists through the normalized runtime path and powers cache-aware stats in the conversation pane
- assistant thinking text now persists through the normalized stream path and renders in a collapsible thinking block during and after streaming

## Next Slice
- expand normalized runtime to more providers
- add attachments and image generation
# Slice 3 Parity Follow-up: Custom Model Picker

## Goal
Restore the richer `v1` chat-model selection surface without waiting for the remaining cost/cache work.

## Implemented
- replaced the native chat-model `<select>` in the conversation header with a provider-grouped custom picker
- grouped available chat models by provider with expandable provider sections
- preserved outside-click dismissal and current-model highlighting
- kept the existing persisted `modelId` update path so model-switch runtime defaults still flow through the same API behavior
- updated browser coverage to drive the custom picker path instead of the old native select

## Notes
- this closes the custom model picker portion of Gap 3.3
- later cost and cache follow-ups closed the rest of Gap 3.3

## Acceptance Evidence
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`

# Slice 3 Parity Follow-up: Cost Visibility

## Goal
Restore the `v1` cost surface on the active conversation without claiming unfinished cache parity.

## Implemented
- added shared per-model pricing metadata to the shipped chat catalog
- added session-level estimated cost stats to the conversation header
- added per-message estimated cost rendering beside the existing usage counters

## Notes
- this closes the cost-visibility portion of Gap 3.3
- later cache follow-ups closed the rest of Gap 3.3

# Slice 3 Parity Follow-up: Cache TTL Control

## Goal
Restore the `v1` Anthropic cache TTL control without claiming unfinished cache accounting parity.

## Implemented
- added durable session-level `cacheTtl` state to the shared workspace/session shape
- restored Anthropic-default cache TTL behavior on new sessions and model switches
- reset cache TTL to `off` on models that do not support prompt caching
- wired Anthropic runtime requests to emit the matching `cache_control` setting
- added an Anthropic-only cache control in the active conversation runtime panel

## Notes
- this closes the cache TTL control portion of Gap 3.3
- later cache-accounting follow-up closed the rest of Gap 3.3

# Slice 3 Parity Follow-up: Cache Accounting And Cache UI

## Goal
Finish the remaining cache parity by restoring persisted cache accounting and cache-derived UI.

## Implemented
- extended normalized chat usage with cache read/write token fields
- persisted cache read/write token usage on assistant messages and pending recovery rows
- parsed Anthropic cache usage in the provider runtime
- added cache read/write/hit-rate stats plus cache-aware cost in the conversation pane
- added per-message cache usage indicators alongside the existing usage and cost line

## Notes
- this closes the remaining cache-accounting portion of Gap 3.3
- Gap 3.3 is now closed

# Slice 3 Parity Follow-up: Thinking Surface

## Goal
Restore visible assistant thinking in the normalized `v2` chat path.

## Implemented
- added `response.thinking.delta` to the normalized stream contract
- persisted assistant `thinking` text on completed and pending-recovery messages
- emitted thought deltas from OpenAI, Anthropic, Gemini, and z.ai runtimes where available
- added a collapsible thinking block to the conversation pane for both live streaming and completed assistant messages

## Notes
- this closes the thinking/thought-presentation portion of Gap 3.2
- a later concurrent-streaming follow-up closed the rest of Gap 3.2

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatService.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`

# Slice 3 Parity Follow-up: Concurrent Session Streaming

## Goal
Restore the `v1` behavior where one session can keep streaming while the user switches to another session and starts a second stream.

## Implemented
- moved active stream state out of the currently open conversation view and into a shell-level per-session registry
- preserved pending user rows, partial assistant text, and partial assistant thinking while switching active sessions
- allowed a second session to start streaming while the first stream is still in flight
- restored sidebar and wizard-slot streaming indicators for sessions with active chat work
- updated the mock runtime and browser coverage so automated verification exercises overlapping session streams

## Notes
- this closes the remaining concurrent-streaming portion of Gap 3.2
- Gap 3.2 is now closed

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatRoutes.test.ts`

# Slice 3 UX Re-open: Conversation Layout

## Re-open Trigger
- live test exposed that the earlier Slice 3 closure was too generous at the shell/ergonomics level
- the shipped `v2` conversation surface had drifted into a static layout with:
  - bulky always-open runtime/context panels
  - a fixed-height inner transcript scroll region
  - less of the message-first feel that current `v1` preserves

## Current Repair Pass
- runtime controls are collapsible again
- campaign context is collapsible again
- the active conversation now uses the available pane height instead of a hard `28rem` transcript cap
- a second live-feedback follow-up tightened the conversation surface further:
  - campaign context is back to separate side-by-side prompt/seed frames on desktop
  - bottom stats are compact inline metrics instead of oversized card blocks
  - the conversation header/content balance is closer to the message-first `v1` layout

## Validation Status
- `npm run typecheck`
- `npm run build`
- live browser validation on test is still required before calling this re-opened gap closed again
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
