# Changelog

All notable changes to TracyHill RP are documented here. The project ships as open source on GitHub as a squashed release with its engineering history preserved in the per-slice docs under `docs/v2/`. This file is organized by feature area rather than by date — each section summarizes the cumulative state of that area as of the current release.

## Unreleased

Active development continues against the private upstream. See [`docs/v2/`](docs/v2/) for per-slice engineering documentation.

## 1.4.0 — Frontier Model Refresh & Provider Catalog Overhaul

This release adds the newest frontier models (Claude Fable 5, Xiaomi MiMo), rebuilds the Claude Code workspace, introduces always-on observability for background systems, and lands a full top-to-bottom provider-catalog audit: every model's context window, output limit, pricing (including cache and long-context tiers), and thinking interface was verified against current provider documentation and live API behavior, and the catalog, runtime, and cost accounting were corrected to match.

### New models & providers

- **Claude Fable 5** (direct + Claude Code bridge variant) — Anthropic's Mythos-class tier above Opus. Thinking is always-on adaptive and the UI locks the control accordingly; safety-classifier refusals are categorized (including the new reasoning-extraction category) in the refusal card.
- **Xiaomi (MiMo v2.5 Pro / v2.5)** — new first-class provider over an OpenAI-compatible API. 1M context, streamed reasoning, and a plain On/Off thinking toggle. Adds the `supportsToggleThinking` capability class used by other toggle-thinking providers below.
- **OpenAI `chat-latest`** — the conversational ChatGPT Instant tuning as a plain chat-completions model.
- **Image models refreshed** — GPT Image 2 and Gemini 3.1 Flash Image replace their deprecated predecessors.

### Provider catalog audit (verified against live APIs)

- **Retired models removed, stored references migrated.** Models retired or silently redirected upstream were removed from the catalog (Claude Sonnet 4; Grok 4, both Grok fast families, Grok 3 / Mini — all of which the upstream had been silently serving as grok-4.3; DeepSeek V3 / R1, now aliases of V4 Flash; o3, o4-mini, GPT-4.1 Nano). A data migration remaps any stored session, campaign, and pipeline references to the catalog successors.
- **Corrected ids and limits.** GPT-5.5 uses its proper dotted id; Grok 4.20 moved to its GA ids with corrected context size; MiMo's max output corrected to the API's real cap (8× higher than previously modeled).
- **Pricing corrections** — DeepSeek V4 Pro's permanent price cut, MiMo's flat schedule, cached-input pricing across OpenAI / z.ai / DeepSeek, and **long-context tier pricing** (Gemini 3.1 Pro / 2.5 Pro and grok-4.3 reprice large requests) now reflected in the cost overlay.
- **Honest thinking controls everywhere.** z.ai and DeepSeek V4 gain a real On/Off thinking toggle (off genuinely disables reasoning). Gemini "off" now sends a true disable where the API supports it, the lowest legal thinking level where it doesn't, and Gemini 2.5 Pro is modeled as always-on — no configuration silently bills invisible thinking anymore. xAI and OpenAI reasoning models map "off" to their non-reasoning effort levels for background/automation calls.
- **Usage accounting completeness.** Reasoning/thinking tokens are now captured and displayed per message on every provider that itemizes them; cached-input tokens are captured on all dialects; Gemini thinking tokens count toward billed output. Serving-model and stop-reason reporting now works on every provider dialect, extending the serving-model transparency badge beyond Anthropic.

### Claude Code workspace v2

- Rebuilt timeline (modular renderer, stable streaming core with no re-render flicker, lossless tool output), GitHub-flavored-Markdown tables in the shared renderer (benefits main chat too), a real context-usage meter, task progress panel, plan-approval flow, and binary permission modes (read-only research vs. full execution) switchable mid-session.

### Observability — no silent failures

- New **system events** infrastructure: background subsystems (embedding indexing, retrieval, HyDE, researcher, scene validator, pipeline workers, system-prompt audits) record persistent, user-visible events on failure and degrade gracefully instead of silently dropping work. Surfaced via a global unacknowledged-events badge and per-turn context-preview warnings.
- Hardening pass across streaming, context assembly, scene handling, auth/http, and workers (three companion migrations), plus a guard that prevents a failed system-prompt audit from ever overwriting a campaign prompt with an error message.

## 1.3.0 — Lorebook Context Engine

This release replaces the single free-text campaign "state seed" with a structured, individually-addressable **lorebook** and a per-turn **Context Engine** that assembles only the entries relevant to the current scene into the prompt — so long-running campaigns can carry thousands of facts without dumping the entire world into every request. It also folds in the 2026-05-20 security, reliability, and dead-code hardening pass and the Claude Opus 4.8 / fast-mode provider work.

### Context engine — the lorebook architecture

- **Structured lorebook replaces the monolithic state seed.** Campaign world-state is now a set of individually-addressable entries (characters, locations, factions, events, threads, …), each with its own keys, tags, content, and metadata — superseding the single free-text state-seed document. Entries are bootstrapped by the wizard, refined automatically by the pipeline, and editable by hand.
- **Per-turn Context Engine.** Each turn assembles context by activating only the entries that matter, through parallel signals: **keyword** matching (regex over a scan-depth window of recent turns), **semantic** retrieval (embedding cosine similarity), an LLM **researcher** pass (a small model picks the most relevant entries out of the candidate set), and a **scene-presence** override — combined with sticky/cooldown weighting under a hard token budget.
- **HyDE query expansion.** Each user turn is optionally rewritten by a small model into a hypothetical-answer query that widens semantic recall (toggleable in the Engine popover).
- **Synonym key expansion.** Entries created or updated by the pipeline auto-expand their key lists with synonym variations, so keyword activation is robust to phrasing drift.
- **Tiered archival with lazy cold inflation.** Inactive entries flow active → **compressed** (synopsis + keyword union, still indexed) → **cold storage** (full content preserved but normally excluded from context). A cold entry is inflated back into context only when it activates; how aggressively cold entries compete for the budget is tunable (see *later refinements* below).
- **Wizard produces a lorebook.** The campaign wizard now bootstraps a structured lorebook from the guided conversation instead of emitting a single seed document.
- **Pipeline split into automatic rolling diffs + manual deep refreshes.** Routine play enqueues lightweight **rolling-diff** passes that update only the affected entries (character-count thresholds; a **consolidation** pass every 10th rolling diff and an **archival** pass every 20th); heavier whole-corpus refreshes run on demand. Per-campaign serialization with mutual exclusion keeps overlapping writes from racing.
- **Scene validator.** A per-turn pass reconciles which characters are present, present-but-unaware, or absent against the unfolding narrative, surfaced as a three-way resolution control (accept the validator's pick, keep yours, or regenerate). Renamed from the "presence validator."
- **In-world date/time scene metadata.** `[SCENE]` blocks carry in-world date and time fields, with a manual editing UI.
- **Engine popover — every retrieval/LLM/embedding surface is UI-controllable.** A single sectioned popover exposes Retrieval, HyDE, Researcher, Rolling Diff, Scene Validator, Pipeline Auto-Enqueue, Anti-Repetition, and UI controls, annotating which model each inherited surface uses.

### Context engine — later refinements (2026-05-20 → 2026-06-01)

- **Narrative thread tracker.** A new pipeline pass maintains the campaign's open story threads as lorebook state: a single always-in-context index entry (one line per open thread — title, headline, status, dates) plus a full detail entry per thread (summary, next beat, dated chronology) retrieved only when the scene references it. Threads move through a lifecycle — pending (kept in the index) → a fixed-size grace window of most-recently-resolved threads → graduation, where older resolved threads are re-tagged into the event history and drop out of the index. Bounded at 80 tracked threads, fully fail-safe (no partial writes on error), with a status-strip chip + popover surfacing the live set. The worker re-embeds the entries it rewrites each run so semantic vectors track content.
- **Character attire tracking.** New `character_attire` / `character_attire_history` tables and a per-turn `<character_attire>` context block listing every present (or present-but-unaware) character's current outfit with a freshness annotation. The scene validator reconciles attire alongside presence; the wizard seeds starting attire on character entries. Tunable via `attireTrackingEnabled` / `attireStaleTurnThreshold`.
- **Cold-inflation weight multiplier.** A per-campaign/session knob (default 0.6, range 0–2) controls how aggressively lazily-inflated cold-storage entries compete for the token budget; 0 skips cold inflation entirely.
- **Campaign-level embedding model.** The embedding model is now selectable on the campaign itself (Context tab), not just per session — so it reaches the retrieval path, the pipeline workers, and manual lorebook edits consistently.
- **Embedding catalog refresh.** Retired the deprecated `text-embedding-004`; the Google embedding option is now `gemini-embedding-2` (3072-dim) and sends `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task types. The catalog now offers OpenAI `text-embedding-3-large` (3072) / `-3-small` (1536) and Google `gemini-embedding-2` (3072).

### Providers & runtime (2026-05-23 → 2026-06-01)

- **Claude Opus 4.8** added to the catalog (and as a `-bridge` variant), adaptive-thinking-only like 4.7.
- **Anthropic fast mode** — an optional per-session speed toggle (default off) on the Opus 4.6/4.7/4.8 direct models, emitting the `speed:"fast"` request flag with its own pricing tier; persisted per message so the UI can badge which responses actually used it.
- **Refusal surfacing** — when a provider returns structured `stop_details`, the refusal category is persisted and rendered as a distinct refusal card instead of an opaque empty response.
- **Adaptive-only sampling params** — the provider runtime now omits `temperature` (and the other sampling params those models reject) for adaptive-thinking-only models on both the direct and bridge paths.
- **Bridge runtime defaults** — switching a session to any Claude Code `-bridge` model now defaults it to adaptive thinking + max effort instead of falling through to thinking-off.

### Security hardening (2026-05-20)

- **No account enumeration on `POST /api/auth/forgot-password`.** The response shape is constant regardless of whether the supplied username matches an existing user with an email. Non-existent users are silently issued a dummy reset entry that rejects every code submission with `"Invalid code"`, so the SPA flow looks identical from outside. Rate-limited at 10 attempts / 15 min per IP. The `resetToken` and `emailMasked` response fields are now required (were `.optional()`).
- **Custom OpenAI-compatible endpoints are SSRF-gated.** The `baseUrl` must parse as a valid `http(s)://` URL with no userinfo, and at save time the server resolves the hostname and rejects entries that resolve to any private/loopback/link-local/CGNAT/reserved IPv4 range or IPv6 `::1` / `fc00::/7` / `fe80::/10` / multicast. Operators can opt-in to LAN endpoints (LM Studio, Ollama, etc.) via the new `CUSTOM_ENDPOINT_ALLOW_HOSTS` env var. Upstream error response bodies from custom endpoints are stripped before bubbling to the client SSE event.
- **Embedding service no longer shares user API keys across users.** Per-user provider keys are now constructed fresh per request and never cached; the cache is reserved for env-level fallback providers seeded at app startup.
- **Admin cannot delete or demote the last admin.** `AdminService.deleteUser` and `AdminService.updateUserRole` mirror the existing self-deletion guard with a `countAdmins() <= 1` check.
- **Account-delete cascade is complete.** Now also cleans up `chat_message_embeddings`, `pipeline_run_artifacts` (via subquery), `pipeline_approvals_audit`, and active HTTP sessions for the deleted user.
- **`drizzle-orm` bumped to `^0.45.2`** — clears the upstream SQL identifier-injection advisory.

### Reliability hardening (2026-05-20)

- **Provider-runtime SSE hardening across all seven streaming providers** (Anthropic, OpenAI Responses, OpenAI Chat Completions, Google Gemini, xAI, DeepSeek, z.ai): streaming read loops wrap in `try/finally` with `reader.cancel()` so mid-stream errors don't leak the Web Streams reader. OpenAI Responses runtime now fires `onComplete` even if the upstream closes without `response.completed` (previously hung the consumer) and flushes any residual buffer after the loop ends. The SSE chunk parser resets the event-name buffer at each blank-line boundary per spec. Upstream error response bodies are read through a 16 KB-capped reader so a misbehaving provider can't pin RAM with a multi-MB error page.
- **API process survives worker drain failure under `INLINE_WORKERS=1`.** `PipelineWorker.kick()` and `WizardWorker.kick()` now wrap the async drain in `try/catch`, and their cancellation-poll intervals catch any DB lookup glitch.
- **`errorHandler` no longer throws after headers are sent.** Streaming endpoints that error mid-flight skip the status/json path and just end the connection; the stream is responsible for its own `response.error` SSE event.
- **Atomic system-prompt audit version write.** `syspromptAuditWorker` writes the prior version archive and the campaign bump in a single transaction via the new `CampaignRepository.bumpVersionWithArchive()`.
- **`lorebookArchivalWorker` uses session turn count, not lorebook entry count, for staleness gating.** Previously `currentTurn` came from `lorebook.countForCampaign()` (a row count) so the `MIN_TURNS_INACTIVE >= 500` gate fired against the wrong reference, and as entries got archived the count DECREASED.
- **Pipeline stream bus bounded.** Hard cap of 200 tracked runIds with LRU eviction; safety-net sweep every 10 min evicts buffers idle 1 h+.
- **Markdown rendering keeps inline code intact.** Inline-code spans extracted into PUA sentinels before bold/italic/link/dialog regexes run, so `` `**word**` `` inside backticks no longer gets `<strong>` injected inside `<code>`.
- **Chat-stream SSE parsers no longer kill the whole stream on a malformed frame.** One bad event in chatApi/codexApi is silently skipped; the stream continues with the next event.
- **Login session save is explicit.** `authController.login` now awaits `req.session.save()` after `regenerate()`, preventing the new session ID from being lost if the client closes early.
- **String[] `req.query` and `req.headers` values are handled.** A new `apps/api/src/lib/headerUtil.ts` provides `firstHeaderValue()` and `firstQueryValue()`; the prior `as string` casts joined arrays with commas, producing malformed `campaignId`/`x-request-id` values.

### Frontend reliability (2026-05-20)

- **Autoscroll pauses when the user has scrolled away from the bottom.** Scrolling up to re-read context mid-stream no longer yanks you back to the latest delta on every chunk.
- **401 on any authenticated path now bounces the SPA to login.** An auth-invalidation listener wired into `apiFetch` invalidates the current-user query so the user isn't left stranded behind error toasts when a session is revoked from another tab.
- **`Cmd+L` in the ClaudeCode composer actually clears the textarea.** The handler now calls the native `HTMLTextAreaElement.prototype.value` setter and dispatches an `InputEvent` so React's controlled-input state updates.

### Dead-code removal (2026-05-20)

- **F2 typed-edits subsystem removed.** `packages/pipeline-core/` (applier, all section parsers, serializer, sysprompt parser/serializer, kind registry, normalize, internal tests, and markdown fixtures) and `packages/contracts/src/pipeline/` (typed `Seed`/`Sysprompt`/`ExtensionEdit` schemas) were scaffolded as a planned migration from V4's raw-text pipeline. The migration never landed — workers continue to run `V4_ANALYSIS_PROMPT` / `V4_SYSPROMPT_UPDATE_PROMPT` / `V4_REPETITION_DETECTION_PROMPT` from `apps/worker/src/pipeline/pipelinePrompts.ts`. **~6,200 LOC removed** across the package, its contracts, and `apps/worker`'s dropped dep.
- **Wizard defaults are now self-contained.** `apps/api/src/domain/wizard/wizardDefaults.ts` previously read `server/wizard-defaults.js` at runtime — that V1 directory is preserved only as a rollback safety net per the cutover plan and is slated for deletion once that window closes. The `DEFAULT_EXAMPLE_SYSTEM_PROMPT` template literal is now inlined directly. **V2 has no remaining runtime dependency on V1 files.**
- **10 confirmed-orphan exports deleted**: `isTestEnv` (`config/paths.ts`), `extractColdStart` (`domain/campaigns/coldStart.ts`), `healthResponseSchema`/`HealthResponse`, `restoreSessionRequestSchema`/`startSessionFromCampaignResponseSchema`, `pipelineRunKindSchema`/`PipelineRunKind`, `codexOkResponseSchema`/`CodexOkResponse`, `embeddingProviderIdSchema`/`EmbeddingProviderId`, `sceneChanged()` (`domain/chat/sceneParser.ts`), `renderHighlightedText()` (`features/chat/SessionConversation.tsx`), the deprecated bare `requireAuth` handler. The unused `streamControllers` map and `abortSessionResponse` export in `chatApi.ts` also removed.

**Net code change across the 2026-05-20 security + reliability + dead-code pass: −5,330 lines of TypeScript across −32 files (−11.5%).**

### F2 pipeline reliability (historical — the F2 typed-edits codebase has since been removed)

These fixes landed in prod via `deploy-20260423-164734` and `deploy-20260423-210220`. The F2 typed-edits subsystem itself was subsequently identified as orphaned (the V3 lorebook engine and V4 raw-text prompts had superseded it without removing the dead code) and removed in the 2026-05-20 dead-code purge. Listed here for engineering-history continuity.

- **Section G parser unifies slugification with Section F** — both now slugify the full character header. Previously Section G stripped at the first `/` or `(`, producing different ids for the same character; LLM ops targeting Section F's id created new Section G entries instead of updating existing ones. Section G now also merges duplicate entries on parse so already-drifted campaigns self-heal on the next run.
- **`add_character` and `add_character_firmware` appliers reject duplicate ids** with a hint to use the corresponding `update_*` op.
- **`extractLabeledBlock` and `extractExtraSections` lookahead raised** from `{2,60}` to `{2,200}` characters so long parenthesized date anchors (e.g., `**Current emotional state (post-Part-N, ...):**`) no longer prevent field extraction. `extractExtraSections` taken-check uses `startsWith` to catch parenthesized variants of reserved labels, including nested parens.
- **MANDATORY FACT PROPAGATION rule** added to the F2 system prompt — when a single fact changes (separation hours, cluster counts, treasury), the planner is required to grep for old values and emit edits at every site, not just the primary section.
- **`remove_does_not_know_item` op** added to the contracts schema and applier with a 20-character minimum justification. Previously the pipeline could only append to "Doesn't Know" lists, never correct contradictions when a character later learned the information.
- **MANDATORY INFO-BOUNDARY RECONCILIATION rule** added to the F2 system prompt with an explicit failure-pattern example. Section G vocabulary listing in the prompt now surfaces all five info-boundary ops (`add_knows_item`, `remove_knows_item`, `add_does_not_know_item`, `remove_does_not_know_item`, `promote_doesnt_know_to_knows`) with when-to-use guidance.

### UI
- **Scene divider truncates long location strings cleanly.** When the scene-tagger LLM emits an unusually verbose `location` value (200+ char compound description), the divider label now ellipsizes within the message column instead of pushing the message list into a horizontal scroll state. Implementation: `.message-list > * { min-width: 0; max-width: 100% }` on grid items so they can shrink below their min-content, plus `overflow: hidden + text-overflow: ellipsis` on the scene-divider label. Clicking the divider still expands to show the full present/notPresent detail block, so no information is lost.

## 1.2.0 — Scene Markers, Narrative Quality, and Claude Opus 4.7

### Campaign narrative system
- **In-session scene markers** — assistant responses emit `[SCENE]` blocks containing `location`, `present`, `presentUnaware`, and `notPresent` fields. The parser strips the block from the visible narrative and persists it to `messages.scene_data` as JSON. Downstream turns receive a `<scene_state>` context injection (XML-wrapped to prevent model mimicry) so knowledge boundaries are enforced across scene transitions.
- **Scene instruction positioning** — the scene-authoring instruction is now the first block in the system prompt (before campaign content), which materially improved compliance on long-context runs.
- **Scene context carry-forward** — assistant messages without scene_data inherit the last known scene state so one missed emission doesn't spiral into a compliance gap.
- **Character roster session reset** — the roster rebuilds from the Character Voice Firmware section of the system prompt at each session start, so dead or removed characters don't linger as "NOT PRESENT" clutter. During a session, new names surface via `[SCENE]` blocks.
- **Narrative quality tags** — scene weighting (`PIVOTAL` / `SIGNIFICANT` / `SUPPORTING` / `TRANSITIONAL`), retention classification (`PERMANENT` / `DURABLE` / `FADING` / `EPHEMERAL`), NPC `DISPOSITION` blocks, and thread staleness tracking (`STARTED` / `LAST_PROGRESSED`).

### Templates & examples
- **Demon Cycle example documents** — replaced the placeholder Ashenmoor examples with a 1,409-line state seed plus 633-line system prompt (MC: Alex Wyatt) that exercises every template feature end-to-end.
- **Enhanced update templates** — density-relative pattern detection, narrative-prose character-entry standard with figure specifics, explicit institutional-vs-private knowledge distinction, explicit public-vs-private world-state rule.
- **Wizard Phase 2 rewrite** — the wizard now copies the shared update templates verbatim instead of round-tripping through an LLM rewrite, eliminating drift and one-off hallucinations.

### Pipeline
- **Expanded validation** — 14 checks across 5 categories (up from 8 flat checks).
- **Full transcript context** — the pipeline sends the complete session transcript instead of the last 6 messages (brought forward in 1.1.0; reinforced here with validation coverage).
- **Abandon Run** — hard-deletes a pipeline run without bumping the campaign version.
- **Default model** — seed pipeline + campaign wizard now default to `claude-opus-4-7`, with `thinkingMode: "off"` and `effort: "max"` on every `runModelPrompt` call.

### Providers
- **Claude Opus 4.7 support** — added to the catalog as adaptive-thinking-only (no explicit thinking budget). Effort options low → medium → high → xhigh → max, mapped to `output_config.effort` on the Anthropic request. The Anthropic runtime branches on `supportsAdaptiveThinking && !supportsThinkingBudget` to select the 4.7 code path.
- **Gemini SSE fix** — the SSE line-splitter was matching LF only; Gemini emits CRLF, which caused frames to concatenate. All four streaming runtimes (Anthropic, OpenAI, Google, xAI) now normalize CRLF → LF before splitting.
- **Gemini thinking surface** — thinking text was being dropped; enabled `includeThoughts: true` on the request so reasoning surfaces alongside output.

### Claude Code bridge
- **Model & effort picker** — surface in the bridge dialog matching the chat surface's controls.
- **Interrupt button** — cancels an in-flight Claude Code run.
- **Status endpoint** — polled by the dialog to reflect bridge health.
- **CTRL+V image paste** — pasted images upload and attach inline.
- **Opus 4.7 thinking toggle** — the bridge respects the per-model adaptive-only semantics.

### Tests
- **Playwright e2e suite** expanded: auth, forgot-password, MFA, registration, sidebar drag-and-drop, nested folders, imported-data parity.
- **Per-workspace Vitest configs** across API, web, worker, and shared packages.

## 1.1.0 — Security Hardening

### Security
- **Encrypted provider keys** — all user API keys and custom endpoint keys are now encrypted at rest using AES-256-GCM with a key derived from SESSION_SECRET via HKDF. Existing plaintext keys auto-migrate on first read.
- **SQLite session store** — replaced Express MemoryStore with a durable SQLite-backed session store (`http_sessions` table). Sessions persist across container restarts.
- **CSRF defense-in-depth** — added `X-Requested-With` custom header requirement as fallback when the Origin header is absent.
- **Rate limiting expansion** — MFA verification, registration, and password reset endpoints now have per-IP rate limiting (10 attempts per 15-minute window).
- **Login rate limiter fix** — now uses `req.ip` (respects trust proxy) instead of `req.socket.remoteAddress`.
- **TLS hostname verification** — restored Node's default `checkServerIdentity` on Claude Code and Codex bridge HTTPS connections.
- **Non-root Docker container** — runtime image now runs as UID 1001 (appuser) instead of root.
- **Trusted device token hashing** — device tokens stored as SHA-256 hashes instead of plaintext.
- **Markdown XSS fix** — `escapeHtml` now escapes double quotes, preventing attribute injection in rendered links.
- **Production guards** — app refuses to start if `EXPOSE_AUTH_CODES=1` with `NODE_ENV=production`. Removed `MOCK_PROVIDER` from session secret dev-override.
- **Deprecated requireAuth replaced** — admin, Claude Code, and Codex routes now use the factory `createRequireAuth(users)` that verifies user existence on every request.
- **Pipeline controller validation** — approve and retry endpoints now validate request bodies with Zod schemas.

### Pipeline
- **Full transcript context** — pipeline now sends the complete session transcript instead of only the last 6 messages.
- **Sticky action bar** — approve/retry/cancel buttons pinned to top of pipeline scroll area, always visible.
- **Abandon Run** — new button to hard-delete a pipeline run without bumping the campaign version.
- **Removed 400px height cap** on pipeline review section.

### Bug fixes
- **Phantom `MFA_TRUST_DAYS` removed** — was documented but never implemented. Trust duration is hardcoded at 30 days.
- **V1 scripts removed** from root package.json (`dev:v1`, `build:v1`, `start:v1`, `set-password`).

---

## 1.0.0 — Initial Public Release

The public release is the culmination of a ground-up rewrite to TypeScript, SQLite, npm workspaces, and a worker-backed job model. The architecture is the same shape as the original private implementation but every subsystem is cleaner, better tested, and designed to be self-hosted out of the box.

### Foundation
- Monorepo restructured to **npm workspaces**: `apps/api`, `apps/web`, `apps/worker`, plus shared `packages/contracts`, `packages/db`, `packages/logging`, `packages/model-catalog`, `packages/provider-runtime`, `packages/test-fixtures`.
- **Strict TypeScript** across every workspace, shared Zod contracts between frontend and backend.
- **SQLite + Drizzle ORM** replaces the original JSON-on-disk data store. WAL journaling, atomic writes, better-sqlite3 native bindings, auto-migration on startup.
- **Structured pino logging** with request-ID middleware and child-logger pattern. Log rotation via Docker json-file driver.
- **Database-backed audit events** for high-value admin, auth, pipeline, and wizard actions.

### Authentication & account management
- Multi-user account system with **bcrypt password hashing**, **per-user session cookies** (`httpOnly`, `secure`, `sameSite:lax`), session fixation prevention via post-login regeneration.
- **Self-service registration** with email verification — user submits username, password, email, agrees to Terms, receives a verification code, confirms, gets logged in.
- **Forgot-password flow** — username lookup, email code delivery, code verification, new password entry.
- **Password complexity enforcement** (upper, lower, digit), timing-safe bcrypt comparison on unknown usernames.
- **Email MFA** with SendGrid delivery. Per-challenge HMAC secrets, one-time 6-digit codes.
- **Trusted device cookies** — "Trust this device" bypasses MFA for a configurable number of days. Timing-safe comparison.
- **Account deletion** — 3-step flow with MFA gate and explicit confirmation.
- **Public legal pages** — Terms of Service and Privacy Policy rendered server-side at `/terms` and `/privacy`.
- **Per-IP and per-username rate limiting** on login and reset endpoints.

### Sidebar, workspace chrome, and session organization
- **Full shell chrome** with collapsible sidebar, drag-to-resize width, topbar with model picker, controls bar, status bar.
- **Nested folders** with drag-and-drop session-to-folder moves, folder-to-folder parenting, collapse/expand state, depth limit enforcement.
- **Recycle bin** — soft delete with 30-day auto-purge, restore, permanent delete, bulk empty.
- **Session search** — global search across all sessions (body + name), in-session `Ctrl+F` prev/next navigation, search highlight with XSS-safe escaping.
- **Session export** — clean markdown export with stop-marker stripping and error-message filtering.
- **Session folders** with drag-and-drop session moves, right-click context menus using in-app confirmation dialogs (never native `confirm()`).

### Chat core
- **Normalized streaming contract** across all providers. Server-side accumulating proxy that completes responses even when the browser disconnects mid-stream — pending messages are merged on reconnect.
- **Per-session stream state** (set of streaming session IDs, per-session abort controllers, per-session text/thinking/usage accumulators). Supports streaming multiple sessions simultaneously with live dots in the sidebar.
- **Message lifecycle** — edit, delete, resend, regenerate, cut-after, copy. Copy always available (even during streaming); other actions hidden while streaming. Long messages (>20 lines) show action bars at both top and bottom.
- **Disconnect recovery** — streaming responses accumulate on the server and save even if the browser closes. Reconnection merges pending messages, with dedup protection.
- **Output-truncation detection** — responses that hit `max_tokens` append a visible warning marker.
- **Stop streaming** mid-response. Aborts the upstream request, saves whatever was received.
- **Context-window soft warning** — inline notice when the session approaches the active model's context limit.

### Providers
- **Anthropic** — Claude Opus 4.6, Sonnet 4.6, Sonnet 4, Haiku 4.5. Thinking mode (Off / Budget / Adaptive) with effort control. Prompt caching with configurable TTL (off / 5 min / 1 hour). Cache read/write/hit% surfaced in the status bar.
- **OpenAI** — GPT-5.4, GPT-5 / Mini / Nano, o4-mini, o3, GPT-4.1 family. Reasoning models use the `/v1/responses` API with visible thinking summaries (Low/Medium/High/Minimal effort). Non-reasoning models use Chat Completions. `developer` role instead of `system` for reasoning models. Fixed temperature.
- **Google** — Gemini 3.1 Pro, Gemini 3 Flash, Gemini 3.1 Flash-Lite, Gemini 2.5 Pro/Flash. Two thinking modes: `thinkingLevel` (minimal/low/medium/high) on 3.x, `thinkingBudget` on 2.5. Native PDF + image support via `inlineData`.
- **xAI** — Grok 4, Grok 4 Fast (R/NR), Grok 4.1 Fast (R/NR), Grok 4.20 beta, Grok 3 / Mini. Reasoning content surfaced when available.
- **z.ai** — GLM-5, GLM-4.7, GLM-4.7 FlashX, GLM-4.6, GLM-4.5. Always-on thinking with `reasoning_content` in stream deltas. OpenAI-compatible wire format.
- **DeepSeek** — DeepSeek V3, DeepSeek R1. OpenAI-compatible wire format. Always-on reasoning on R1.
- **Custom OpenAI-compatible endpoints** — OpenRouter, LM Studio, Ollama, Together AI, Groq, vLLM, any server speaking OpenAI Chat Completions or Responses. Per-endpoint API keys (Bearer / api-key / none). Per-endpoint model lists with context and output limits. Full disconnect recovery.
- **Per-message model switching** — change model mid-conversation with a single click via the custom dropdown.
- **Custom model picker** — replaces native `<select>` with expandable provider submenus. Custom endpoints surface as their own groups.
- **All provider maxima auto-applied** when switching models — effort, thinking budget, and max output set to the model's API limits.
- **Abort signals honored** across every provider for clean cancellation.
- **Conversation normalization** — consistent turn boundaries, system-block handling, media-turn shaping across providers.
- **Replay transcript sanitization** — transcripts fed back into LLMs are stripped of stop markers and error messages.

### Attachments and image generation
- **Text, markdown, JSON, CSV, and PDF attachments** via paperclip, drag-and-drop, or clipboard paste.
- **Image attachments** — base64-embedded for vision-capable providers. Clipboard paste captures image items with auto-generated filenames.
- **PDF support** — native document blocks for Anthropic, inline `file_data` for OpenAI, warning text for providers that don't support PDFs instead of silent drops.
- **Image generation** — GPT Image 1, DALL-E 3, CogView-4, Grok Image, Grok Image Pro, Gemini Image. All models configured at maximum native resolution and 16:9 (or widest available). Drop-up model selector above the send button.
- **Flat-file image storage** with bulk admin purge.

### Runtime controls
- **Thinking mode controls** — per-provider surfaces for Anthropic (Off/Budget/Adaptive), OpenAI reasoning (effort), Google (thinkingLevel/Budget), z.ai (always on), xAI (content when available). Minimal-effort variants for Anthropic and OpenAI where applicable.
- **Cache TTL** controls with accounting surface — read/write/hit% visible in status bar for cache-supporting providers.
- **Cost visibility** — per-session token totals, estimated cost based on model pricing, aggregated in the status bar.
- **Temperature control** with per-session default.
- **Auto-scroll toggle** (default off).
- **Font size control** via range slider (10–24 px), persisted globally.
- **Collapsible controls bar** and **collapsible status bar** with compact cost peek when collapsed.

### Campaigns and version control
- **Campaign records** — system prompt, state seed, seed-update prompt, sys-prompt-update prompt, version counter, folder linkage, model selection.
- **Campaign CRUD** — create, edit, delete, duplicate, with inline form and tabbed editor.
- **Start session from campaign** — automatically injects the system prompt and state seed into a new session and links it via `campaignId`.
- **Version history** — every approved pipeline run archives the current seed and system prompt to `campaign_versions/{campaignId}/`. History tab shows compact rows with preview and restore.
- **Campaign folders** — pipeline trigger moves sessions into the campaign's folder and auto-renames to "Part N (date)".
- **Runtime prompt shape** — cold-start injection of system prompt and state seed at the start of every session.

### Pipeline
- **Seven-step pipeline** (Step 1 seed generation + Step 3 system prompt assessment run in parallel, Step 2 validation runs after Step 1, Step 2.5a/b auto-fix runs if Step 2 fails, Step 3.5 apply diffs runs if Step 3 recommends changes).
- **Two-phase surgical fix** — failed validation triggers an LLM call that produces ADD/REPLACE/DELETE surgical edits (not full rewrites). A second call applies those edits to produce the corrected document.
- **Granular retry** — restart from validation (step 2), from fix (step 2.5), from system-prompt check (step 3), or full pipeline reset.
- **Server-side execution** — pipeline runs persist to disk at each step, survive browser close, resume on reconnect. GET `/api/pipeline/active` detects running/complete pipelines on app load.
- **Cancel support** — destroys in-flight HTTP requests via tracked request Map to stop token burn immediately.
- **Non-blocking UI** — slim banner while running, app fully usable underneath.
- **Multi-provider** — pipeline can run on any of the six built-in providers plus custom endpoints.
- **Retry logic** — auto-retry on transient upstream failures (timeout, 429, 500, 502, 503, 529) with 15s/30s backoff.
- **Operator guidance** — contextual retry buttons surface based on which step failed.
- **Review surface** — full-screen review UI with editable textareas, step indicators, elapsed timer, phase tracking, per-step "applied" badges.

### Wizard
- **LLM-guided interactive conversation** for bootstrapping new campaigns from scratch.
- **Four-document output** — state seed v0, system prompt, seed-update prompt, sys-prompt-update prompt.
- **Two-phase generation** — Steps 1+2 (seed + system prompt) run in parallel, Steps 3+4 (update prompts) run after with the Step 1+2 results as context.
- **Per-user example templates** — 4 tabs of reference documents (example seed, example system prompt, seed update template, sys-prompt update template) pre-populated with instructive defaults.
- **`[WIZARD_READY]` marker detection** — when the LLM has enough info, it emits the marker and a glowing "Generate Campaign" button appears.
- **Pinned wizard session slot** in the sidebar with purple accent, separate from normal sessions.
- **Approve flow** — creates the campaign record, creates the campaign folder, deletes the wizard session, creates a Part 1 RP session pre-loaded with the system prompt and state seed.
- **Multi-model** — wizard can run on any provider with the same model dropdown as chat.
- **Transcript context** and **operator controls** for managing long wizard conversations.

### Admin
- **Users** — list all users, create, delete (with self-guard), reset password, toggle admin role, view any user's sessions and individual session transcripts.
- **Storage** — disk total/used/free, image count and size, user data size, refresh button, free-space-low warning (red below 10%).
- **Bulk image purge** — deletes all generated image files AND strips `generatedImage` references from all user sessions.
- **Provider keys** — see per-provider status (user override / server fallback / not configured), set/replace/clear per-provider keys, manage custom endpoints.
- **Custom endpoints** — full CRUD for OpenAI-compatible endpoints with per-endpoint model lists.
- **Audit events** — database-backed log of admin and auth actions, browseable via the Audit dialog.
- **Claude Code bridge** — admin-only in-app dialog for driving a remote Claude Code agent over HTTPS. Session management, message sending, streaming responses, interrupts, tool-result rendering.
- **Codex bridge** — admin-only in-app dialog for driving a remote OpenAI Codex CLI session over HTTPS. Session + workspace management, command blocks with collapsible output, text responses.

### Importer
- One-way importer for migrating data from the original JSON-on-disk implementation into the SQLite v2 schema. Validation, dry-run reports, pending-message preservation, pipeline and wizard state migration, parity verification. Intended for users upgrading from an older self-hosted install.

### Packaging & operations
- **Multi-stage Dockerfile** (`node:20-alpine` builder + runtime) with `deps` + `build` + `runtime` stages.
- **Production `docker-compose.yml`** with healthcheck on `/api/system/health`, bind-mounted `./data`, log rotation, templated env vars, separate API and worker services.
- **Auto-migration** on API startup — no manual `db migrate` step needed.
- **`SEED_DEMO_USER`** bootstrap flag so `cp .env.example .env && docker compose up` produces a working instance with a logged-in admin.
- **`MOCK_PROVIDER`** flag for offline testing without burning tokens.
- **Playwright e2e suite** for cross-workspace browser tests.
- **Per-workspace vitest suites** for unit and integration tests.

### UI polish
- **V1-style theming** — dark theme (`#0d1117` bg, `#161b22` surface, `#58a6ff` accent), custom webkit scrollbars matching the theme, JetBrains Mono for tool output and monospace UI.
- **Brand logo** on sidebar, login, register, forgot password, verification, MFA pages.
- **Compact login page** with placeholder-only inputs, "Unlock" button, "Forgot password?" link, "Don't have an account? Create one" footer.
- **Themed dialogs** — widened Provider Keys dialog (56 rem), widened Users admin dialog (44 rem) for denser content.
- **Favicon** shipped in `apps/web/public/`.
- **Composer** that blends seamlessly into the message area — no decorative separator bar.
- **Message list top-locking** — short conversations keep messages at the top of the frame instead of stretching to fill the height.
- **Fixed drag-drop regression** where dropping a session onto a folder was being overridden by event bubbling to the root drop zone.
- **Conditional "Move to unfiled" button** — only shown on sessions that are currently filed.
- **Themed dialog backdrop** with correct z-index so dialogs render above the sidebar.
- **Campaign dialog sizing** respects viewport padding and fills the content area without extending behind the sidebar.
- **Claude Code bridge dialog** restyled with V1 `.cc-panel` layout — colored left-border transcript blocks (purple tools, amber thinking, green results, red errors), monospace tool output, collapsible with preview, compact copy buttons.
- **Codex bridge dialog** restyled to share the `.cc-panel` aesthetic — session + workspace dropdowns in compact topbar, command blocks with collapsible output, exit codes, cwd display.
- **Campaign Manager** restructured to V1-style two-panel layout — 240 px campaign list sidebar + tabbed editor with full-height monospace textareas.
