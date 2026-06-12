# v2 DB Schema Notes

**V2 is in production** since 2026-04-13.

## Storage Direction
- SQLite is the structured persistence layer (Drizzle ORM + better-sqlite3, WAL mode).
- Generated images remain on disk, indexed from SQLite.
- V1 data was imported into V2 at cutover (2026-04-13).

## Slice 1 Tables
- `users`
- `user_preferences`
- `audit_events`

## Slice 1 User Shape
- `users` now persists `username`, optional `email`, `email_verified`, `agreed_to_terms`, JSON `trusted_devices`, `role`, `password_hash`, `created_at`, and `updated_at`
- verified registration now writes `email` plus `agreed_to_terms` and stores `email_verified = 1` only after the verification-code step succeeds

## Slice 2 Tables
- `folders`
- `sessions`

## Slice 2 Folder Shape
- `folders` now persists `name`, nullable `parent_id`, `position`, `collapsed`, `created_at`, and `updated_at`
- nested folder hierarchy is modeled directly in SQLite through `parent_id` instead of staying browser-only
- delete-time re-home behavior now relies on reassignment of child `folders.parent_id`, `sessions.folder_id`, and linked `campaigns.folder_id`

## Slice 3 Tables
- `messages`
- `pending_assistant_messages`

## Slice 3 Session Expansion
- `sessions.temperature`
- `sessions.thinking_mode`
- `sessions.thinking_budget`
- `sessions.effort`
- `sessions.auto_scroll`
- `sessions.system_prompt`
- `sessions.state_seed`

## Slice 3 Message Expansion
- `messages.input_tokens`
- `messages.output_tokens`
- `messages.total_tokens`

## Slice 4 Tables
- `message_attachments`
- `generated_images`

## Slice 4 Session Expansion
- `sessions.model_id`
- `sessions.model_id` now has a DB/schema default of `claude-opus-4-6`, correcting the old historical `gpt-5.4-mini` baseline for fresh and migrated `v2` databases
- legacy stored Grok 4.20 rows now normalize forward to `grok-4.20-beta-0309-reasoning` across session/message/campaign/wizard-owned tables so corrected xAI selector ids do not strand existing `v2` data

## Slice 6 Tables
- `campaigns`
- `campaign_versions`

## Slice 6 Session Expansion
- `sessions.campaign_id`

## Slice 7 Tables
- `pipeline_runs`

## Slice 8 Tables
- `wizard_templates`
- `wizard_runs`

## Slice 9 Tables
- `provider_keys`

## Slice 3 Parity Follow-up Tables
- `prompt_templates`

## Slice 8 Session Expansion
- `sessions.session_type`

## Slice 6 Campaign Shape
- stores user-owned campaign records with `name`, optional linked `folder_id`, `pipeline_model_id`, `update_prompt_template`, `system_prompt_update_template`, `system_prompt`, and `state_seed`
- starts each record at `version = 1`
- tracks `created_at` and `updated_at` for later version-history and campaign-start flows

## Slice 6 Campaign Version Shape
- archives prior `system_prompt` and `state_seed` snapshots by campaign/version
- keeps version rows append-only so restore can create a new current version instead of rewinding history
- stores archive creation time separately from the current campaign's `updated_at`

## Slice 6 Launch Shape
- launched sessions persist `campaign_id` but keep campaign prompt/seed on the campaign record
- launched sessions may inherit the campaign's linked `folder_id` when it still exists
- chat detail resolves linked campaign context on demand instead of expanding workspace sidebar state with large prompt fields
- standalone imported sessions can also persist their own `system_prompt` and `state_seed` directly on the session row so `v1` non-campaign prompt context survives migration

## Slice 7 Pipeline Run Shape
- stores durable pipeline run status by campaign/user with `queued`, `running`, `completed`, or `failed`
- keeps requested/start/completion timestamps so API and web polling can show worker progress
- stores step-level review state as structured JSON for seed draft, validation report, and system-prompt draft output
- stores validation pass/fail, auto-fix output, fixed seed output, and retry lineage in the structured JSON review payload
- stores approval metadata with `approved_at` plus indexed summary/error columns without changing the queue identity model
- legacy `v1` `pipelines/*.json` files now import into `pipeline_runs` as historical review/operator state rather than resumable live jobs

## Slice 8 Wizard Template Shape
- stores per-user reference documents for example state seed, example system prompt, seed-update template, and system-prompt-update template
- keeps the row keyed by `user_id` for simple `ensureForUser` semantics instead of a separate template identity model

## Slice 8 Wizard Run Shape
- stores durable wizard run status by user with `queued`, `running`, `completed`, or `failed`
- keeps the selected `model_id` on the run row so approval can seed the resulting campaign with that model choice
- stores step-level wizard output as structured JSON for state seed, system prompt, seed-update prompt, and system-prompt-update prompt
- stores review metadata for `campaignName`, `brief`, `wizardTranscript`, optional `wizardSessionId`, approval target IDs, and retry lineage in the structured JSON payload
- stores approval metadata with `approved_at` plus indexed summary/error columns without changing the queue identity model
- approval now creates a linked campaign folder, deletes the source wizard session when present, and activates `Part 1`

## Slice 8 Session Shape
- `sessions.session_type = "wizard"` identifies the dedicated conversation-first wizard flow
- wizard sessions start with persisted opening user/assistant messages instead of an empty conversation
- wizard sessions are intentionally excluded from normal workspace search/session browsing and are surfaced through a dedicated sidebar slot

## Slice 9 Provider-Key Shape
- `provider_keys` stores one row per `user_id` + provider pair
- rows persist the raw stored API key plus `created_at` and `updated_at`
- runtime selection now prefers the stored per-user key for a provider and falls back to the server env key only when the user has no override for that provider

## Slice 3 Runtime Shape
- session rows now carry provider-runtime preferences instead of leaving them browser-only
- `temperature`, `thinking_mode`, `thinking_budget`, `effort`, and `cache_ttl` are intentionally persisted on the session row so runtime-control state survives reloads and provider/model switches
- `auto_scroll` is stored with the session so runtime behavior survives reloads and session switches

## Slice 3 Usage Shape
- assistant message rows now persist `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, and `cache_write_tokens`
- pending recovery rows carry the same normalized usage shape so disconnect-recovery merges preserve cache accounting

## Slice 3 Thinking Shape
- assistant messages now persist `thinking` text separately from visible response text
- pending recovery rows carry the same `thinking` field so reload-time merge preserves thought visibility

## Slice 3 Disconnect-Recovery Shape
- `pending_assistant_messages` stores user-owned assistant output that completed after the browser disconnected
- pending rows preserve the assistant message identity plus normalized usage so merge-on-load can be idempotent
- merged recovery output is promoted into `messages` and then removed from the pending table

## Slice 3 Prompt Template Shape
- stores per-user chat prompt templates with `id`, `user_id`, `name`, `content`, `created_at`, and `updated_at`
- uses a simple user-owned list model because templates are injected as text attachments, not referenced relationally from messages after send

## V3 Message Expansion
- `messages.scene_data` — parsed `[SCENE]` block state (character presence, in-world date/time) for the turn
- `messages.scene_validator_json` — scene/attire validator output plus the three-way resolution payload
- `messages.scene_resolution_choice` — which resolution the user accepted (validator pick / user pick / regenerate)
- `messages.overhead_json` — per-turn context-assembly accounting (retrieval results, token-budget breakdown)
- `messages.stop_reason` — provider stop reason recorded on every assistant message
- `messages.stop_details_json` — refusal categorization, non-null only on adaptive-thinking Anthropic refusals
- `messages.fast_mode` — whether the provider actually ran the turn in fast mode

## V3 Context Engine Tables (post-cutover, merged to main)
- `lorebook_entries` — per-campaign lorebook with activation mode (keyword/semantic/researcher), keywords, embedding vector, sticky/cooldown settings, known_by (JSON array for epistemic scoping), enabled flag, tag
- `lorebook_activation_state` — per-session/entry activation tracking: sticky_remaining, last_activated_turn. Composite PK on (session_id, entry_id)
- `lorebook_entry_embeddings` — model-scoped embedding vectors per lorebook entry, keyed by entry + embedding model so a campaign can be re-embedded under a new model without discarding the prior vectors
- `chat_message_embeddings` — vector embeddings per message for semantic lorebook activation
- `character_attire` — current per-character attire state used to build the `<character_attire>` context block
- `character_attire_history` — append-only attire-change log behind the attire freshness annotation

## Pipeline F2 Tables
"F2" is a pipeline-hardening phase, not a table name. The phase added two durable-capture tables:
- `pipeline_run_artifacts` — per-stage raw LLM I/O capture for a pipeline run (prompt / response / stream events / edits / rendered), pruned by a separate retention job
- `pipeline_approvals_audit` — structural seed and system-prompt diff persisted at approval time, with a size-alert flag

## Slice 9 Tables (continued)
- `custom_endpoints` — per-user OpenAI-compatible custom provider endpoints

## Indexes (added in migration 0049)
- `idx_messages_session_id`, `idx_messages_user_id`
- `idx_sessions_user_id`
- `idx_lorebook_entries_campaign_id`, `idx_lorebook_entries_user_id`
- `idx_lorebook_activation_state_pk` (UNIQUE on session_id + entry_id)
- `idx_chat_message_embeddings_session`, `idx_chat_message_embeddings_message`
- `idx_pipeline_runs_campaign`

Migrations run through 0055. Later ones add the pipeline queue (0050), lorebook consolidation and archival (0051–0052), the scene validator plus the character-attire tables and the presence→scene validator rename (0053–0054), and the `messages` stop-details / fast-mode columns (0055).

## All Tables (complete list — 25)
- `users`, `user_preferences`, `folders`, `sessions`, `messages`
- `message_attachments`, `pending_assistant_messages`, `prompt_templates`
- `campaigns`, `campaign_versions`, `pipeline_runs`, `pipeline_run_artifacts`, `pipeline_approvals_audit`
- `wizard_templates`, `wizard_runs`
- `provider_keys`, `custom_endpoints`
- `generated_images`, `audit_events`
- `lorebook_entries`, `lorebook_activation_state`, `lorebook_entry_embeddings`, `chat_message_embeddings`
- `character_attire`, `character_attire_history`

(`messages` also has an FTS5 virtual companion from migration 0046 for full-text search; it is not a Drizzle-modeled table.)

## Audit Events
- table: `audit_events`
- columns:
  - `id`
  - `action`
  - `actor_user_id`
  - `actor_role`
  - `request_id`
  - `job_id`
  - `session_id`
  - `campaign_id`
  - `run_id`
  - `target_type`
  - `target_id`
  - `metadata_json`
  - `created_at`
- posture:
  - append-only
  - request-correlated
  - stores metadata summaries only, not secrets or raw prompt payloads
  - optimized first for recent admin/security/operator review rather than long-term analytics

## Modeling Rule
- keep worker step detail in structured JSON first
- do not hyper-normalize pipeline/wizard step state on day one
- add indexed summary columns where needed for status and filtering
