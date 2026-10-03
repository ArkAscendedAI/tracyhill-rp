# Changelog

All notable changes to TracyHill RP are recorded here, newest release first. The 2.0.0 section uses the Keep a
Changelog headings (Added, Changed, Fixed, Security, Removed).

## 2.0.0 — Living World, First-Run Setup and Subscription Sign-ins

Published 2026-10-02, with every change since 1.4.0 (published 2026-06-12). If you run a 1.4.0 deployment, read
**Upgrading from 1.4.0** first: the Compose file, the first sign-in and several defaults have changed.
[ENVIRONMENT.md](ENVIRONMENT.md) documents every setting, and [SECURITY.md](SECURITY.md) the security model.

### Upgrading from 1.4.0

- **Compose runs four services.** `docker compose up -d` first runs a one-shot `tracyhill-rp-init` service, then starts
  the API, the worker and the new subscription runner (`tracyhill-rp-runner`). The runner keeps its data in two named
  volumes, `subscriptions` and `secrets`, and its memory is capped at 3 GB by default (`RUNNER_MEMORY_LIMIT`).
- **`.env` is optional, and so is `SESSION_SECRET`.** When `SESSION_SECRET` is blank, the init service generates a
  random secret on the first start and stores it in `data/v2/session.secret` (mode 0600). It never replaces that file,
  and a damaged file stops the start until it is fixed or removed. The API and the worker read the secret; the runner
  gets only a secret derived from it. A deployment that sets `SESSION_SECRET` keeps its value. Changing the secret
  signs everyone out and makes stored provider keys and the secrets saved in Server settings unreadable.
- **A fresh `./data` folder works on Linux.** The init service hands a root-owned data folder to the app user
  (UID 1001), so nothing has to be created by hand.
- **The demo account is no longer created by default.** `SEED_DEMO_USER` now defaults to `0` and is meant for
  development. A new server opens a first-run setup page (see Added). Upgrading keeps every existing account,
  including a demo account seeded earlier, which keeps its password until you change it or delete the account.
- **Sign-in settings on an existing server.** On a database that already has accounts, the new server settings start
  close to the old behaviour: self-registration stays open (it still needs working email), and two-factor is Optional,
  so accounts with a verified email keep their email codes and authenticator apps become available. Sessions now end
  every day at 3 AM America/New_York (1.4.0 signed people out seven days after they signed in). Change any of it in
  **Options → Admin → Server settings**.
- **Email set in `.env` keeps working.** `SENDGRID_API_KEY`, `EMAIL_FROM` and `EMAIL_FROM_NAME` still take precedence
  and show as locked in Server settings. To manage email from that page instead, run
  `docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/adoptEnvEmailMain.ts --to <address>`
  once. It stores the values and sends a test email to that address. When it exits with 0, remove the three variables
  and run `docker compose up -d`.
- **Starting stance and tier.** On a server that already had accounts, new sessions start at world stance 1 and
  depiction tier 0 (see Adversarial World under Added); a new server starts them at 4 and 3. **Server settings → New
  sessions** changes both.
- **Custom endpoints must use `https://`.** A local server such as LM Studio or Ollama needs TLS in front of it, and a
  private address also needs its host name in `CUSTOM_ENDPOINT_ALLOW_HOSTS`.
- **Smaller request limit.** Request bodies are capped at 1 MB, except chat, lorebook and wizard import requests
  (75 MB, read only after the sign-in is checked), coding panel uploads (28 MB) and sign-in and setup requests (64 KB).
  The previous cap was 100 MB.
- **Coding panel CA files must be mounted.** The image no longer contains the `certs/` folder. If a coding panel uses a
  CA path such as `certs/claude-agent.pem`, mount the folder into the API container, for example
  `./certs:/app/certs:ro`.
- **Removed variables:** `CLAUDE_CODE_BRIDGE_URL` and `CLAUDE_CODE_BRIDGE_SECRET`. The built-in runner serves the Claude
  and ChatGPT subscription models, and each user signs in under **Options → Providers**.
- **Removed models are replaced automatically.** The database migration moves sessions, campaigns, pending replies and
  pipeline and wizard runs that named a removed model to its successor. Old messages keep the model they were written
  with.
- **Foreign keys are enforced.** Rows that earlier versions left without a parent stay where they are and are counted
  in one line of the boot log.
- **Back up the `subscriptions` volume** together with `./data`. It holds every user's subscription sign-in, and
  `docker compose down -v` deletes it.

### Added

#### Deployment and first run

- **First-run setup.** While there is no account, the API prints a one-time setup code in its log
  (`docker compose logs tracyhill-rp`). The setup page asks for the code, creates the first administrator, and then
  asks for a model provider: an API key, or a Claude or ChatGPT subscription sign-in. That last step can be skipped.
  The code changes on every restart and stops working once an account exists, wrong codes are rate-limited, and the
  page warns when it is opened over plain HTTP at an address other than localhost.
- **Account recovery command.**
  `docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name>`
  with `--reset-two-factor` (removes the account's authenticator, recovery codes and trusted devices),
  `--new-password` (sets a random password, prints it once and signs the account out everywhere) or
  `--two-factor-off` (turns two-factor off for the whole server; restart the app afterwards).
- **Worker health.** The worker writes a heartbeat, its container has a healthcheck, and `GET /api/system/health`
  reports the worker's status.
- **`DEFAULT_MODEL_ID`** sets the chat model for new sessions, the wizard and worker fallbacks. It must name a chat
  model in the catalog.

#### Server settings

A **Server settings** dialog for administrators (**Options → Admin → Server settings**). Changes apply without a
restart, every change is written to the audit log, and a value set in the environment takes precedence and shows as
locked.

- **Accounts:** self-registration Off or Open (Open needs working email), the text of the terms and privacy pages, and
  whether sign-up asks people to accept the terms.
- **Two-factor:** Off, Optional or Required, with authenticator apps and email codes as the methods. Under Required,
  anyone without a second factor sets one up at their next sign-in.
- **Email:** SendGrid or SMTP, the sender's address and name, and **Send test**. Email counts as working once a test
  succeeds with the current settings; until then sign-up and password reset are not offered.
- **Shared keys:** server-wide API keys, and a server-wide Claude or ChatGPT sign-in, used by every account that has
  none of its own. The page warns that anything entered there can be used by every account on the server, and that a
  shared subscription may be suspended or banned by its provider. **Connect** stays disabled until that warning is
  ticked.
- **Sessions:** the daily sign-out hour and its time zone.
- **New sessions:** the world stance and depiction tier that new sessions start with when they do not copy a campaign's
  settings.
- **Server:** the settings that stay in the environment (`TRUST_PROXY`, `ALLOWED_IPS` and the coding panels), shown
  read-only.

Related account features:

- **Authenticator apps (TOTP).** Any account can add one from its account dialog with a QR code or the typed key, and
  gets ten one-time recovery codes, which can be regenerated. At sign-in a person enters the authenticator code, a
  recovery code, or an emailed code where the server allows it.
- **Invite links.** **Options → Admin → Users → Invite Links** makes one-time links with a role, an optional fixed
  username and a lifetime of 1 to 30 days. They work with registration off and without email.
- **Reset 2FA** in the same Users dialog removes a user's authenticator, recovery codes and trusted devices.

#### Subscription sign-ins

- **Each user can connect their own Claude or ChatGPT subscription** under **Options → Providers**, then use the
  subscription models (the `-bridge` and `-codex-bridge` entries) for chat, the context helpers, the pipeline workers
  and the wizard. These models appear in model menus once the user's own sign-in, or the server's shared one, is
  connected. A personal connection belongs to one user.
- **The runner is built in.** The `tracyhill-rp-runner` service installs the official Claude Code (through the Claude
  Agent SDK) and Codex programs from npm when the image is built. Each user's credentials stay in a private folder on
  the `subscriptions` volume that only those programs read, so the app never holds the tokens. The API and the worker
  reach the runner over the Compose network with a secret derived from the session secret, and the runner publishes no
  port.
- A session or worker setting that names a subscription model keeps it while its user is signed out. The turn then
  fails with a prompt to connect.
- Deleting an account signs it out of its subscriptions.
- Using a subscription this way is subject to the provider's own terms. Every user signs in with their own account and
  is billed under their own agreement.

#### Campaigns

- **SillyTavern lorebook import.** The empty chat area has a **New Campaign Wizard** button with **Import SillyTavern
  Compatible Lorebook** below it, and the sidebar's wizard slot offers the import too. It reads World Info files and
  character cards saved as JSON with their book (up to 2,000 entries), asks for the campaign's name and the player
  character, and turns the book into a full campaign through the wizard's review and approval. Entry text is kept as
  written, trigger settings carry over, and characters get attire, drives and, for antagonists, a sealed scheme.
- **Living World.** Characters carry drive sheets: wants whose pressure rises while ignored, goals, red lines,
  leverage, concealments, an off-page project and dispositions. A **Drives** panel edits them, with history and revert.
  The agendas of present characters enter each turn at a chosen NPC initiative (subtle, normal or assertive), and the
  composer can hand the scene to a character (spotlight). **Advance the world** simulates the time between scenes,
  either catching up to the story's date or skipping forward, with an optional GM note. By default its proposed events
  apply automatically; with automatic apply off, each goes to a review where it can be vetoed or edited. Every campaign
  keeps a world clock.
- **Dramatist.** A per-session authority over world events. A pacing roll grants permission and a severity ceiling,
  the model proposes at most one beat that cites established material, and a refute-first canon check has to pass it.
  Antagonists' sealed schemes stay out of retrieval and audits. Administrators can read its decisions in **Behind the
  Curtain**.
- **Adversarial World.** Per-session world stance (0 Indulgent to 4 Predatory) and depiction tier (0 to 3), an optional
  model for antagonist decisions, and a storyteller pacing (steady, relaxed or chaotic). The server classifies the
  player's contested actions before the reply and resolves them with its own random roll, seeded on the message so a
  regenerate keeps the outcome. It also tracks consequences, threats, grudges and trust, nemesis ranks and offscreen
  clocks. Only administrators change these settings. A roll override button in the composer resolves one turn's
  contested rolls in the player's favour.
- **Campaign Audit** replaces the approval-gated campaign review. A Quick audit checks the lorebook against itself; a
  Full audit reads the whole story from the first message. Findings pass a refute-first check and a fix check before
  they apply, changes are capped per kind, deletions become disables, and every applied change gets a revision.
  Findings that need a person wait in a findings queue, where you rule on each in free text. Audits run in their own
  lane, resume from a checkpoint after provider errors, and can start automatically after a number of lorebook changes.
  The automatic system-prompt review has an adversarial reviewer too: a rejected rewrite fails the run and leaves the
  campaign's prompt as it was.
- **The campaign wizard** also seeds starting attire, drive sheets and, for antagonists, sealed schemes.
- **Recap.** The **Recap** button writes the story so far, which appears in the Campaign popover.
- **Character Engine** (on by default): per-character voice rules, a plain conversational register, sentence and
  phrase rules, a short style check before each reply, and a per-turn pacing gear seeded on the message so a
  regenerate keeps it.
- **Content Honesty** (on by default): on Google models and Kimi K3, where refusals were measured, it keeps the model
  from refusing or softening what the session's stance and depiction tier already allow. It never widens what they
  allow and changes nothing on other models.

#### Context engine and lorebook

- **Settled replies only.** The lorebook writers use a reply once the next user message keeps it, so discarded
  variants and edited history do not reach canon.
- **The writers read the whole stretch.** The rolling diff and the thread tracker read every settled message since
  their previous run, in several passes when the stretch is long.
- **Character upkeep.** The rolling diff updates every character entry a stretch touched or declares it unchanged. A
  character entry over 12,000 characters (an event over 9,000) is sent back once to move its history into linked
  record entries.
- **Size controls.** Thread tracker fields have size caps, a **Thread guarantee** setting (default 6,000 tokens) bounds
  how much thread text is forced into context, and the turn's context notes say when forced entries leave too little
  room for retrieval.
- **Scene presence.** Each name in the scene finds the entries that are that person. Up to six characters who are
  present but unaware also get their entries, without being treated as knowing what the scene says.
- **Attire follows the transcript.** Deleting, editing, regenerating or switching a reply withdraws the clothing it
  recorded.
- **Drives stay grounded.** A want whose object is out of reach goes on hold and stops escalating. Before a want is
  carried forward, the drive worker sees what the lorebook says about it, so a want that canon has settled is dropped
  or re-aimed.
- **Context per reply.** Each campaign reply keeps the context its turn used (the newest 50 per session), viewable from
  the reply.
- **Larger retrieval budget:** up to 200,000 tokens.
- **Lorebook tools:** entry version history with diff and revert, a Recently deleted view that restores entries, JSON
  and SillyTavern export, character card import (PNG V2/V3 or JSON), bulk actions that append keys or set sticky, and
  **Rebuild Embeddings** for stale and missing entries or for all of them.
- **Local embeddings:** an embedding server that speaks the OpenAI embeddings API can serve nomic-embed-text v1.5 or
  BGE-M3 (`LOCAL_EMBEDDING_URL`).

#### Chat

- **Variants.** Regenerate keeps the earlier reply as a variant, and the arrows on a reply switch between its variants.
- **Long sessions** open on the newest 200 messages. **Load older** pages back, and the **Scenes** outline lists scene
  changes with a filter and jumps to any of them.
- **Safer cuts.** A Cut or Resend that would remove more than two messages asks you to confirm the count, and the server
  refuses a cut from a page that is missing newer messages.
- **Stop** ends a turn at once, also while the context is still being assembled.
- **Notify:** an opt-in browser notification when a reply finishes in a background tab.
- **JSON export** of a session, besides Markdown.
- **Command palette:** Ctrl/⌘ K jumps to any session or runs a command.
- **`GET /api/models`** returns the built-in chat, image and embedding model lists.

#### Coding panels

- **The Codex panel was rebuilt** on the Codex App Server: a full-screen workspace with Read Only and YOLO (full access)
  modes, switchable mid-session; steer, interrupt, compact, review, fork, archive and export; uploads, `@file`
  mentions, `!` shell commands (YOLO only), skills and MCP status. It talks to the sidecar in
  `tools/codex-agent-service`.
- **Kimi (K3) panel:** a second panel on the Claude Code panel's interface, with a per-session choice between
  pay-per-token API serving and a subscription.
- The panels are for administrators and need an agent service you run yourself. They are never set up automatically and
  show greyed out until configured.

#### Models and providers

- **New providers:** Moonshot AI (Kimi), Fireworks AI and GMICloud (hosted open-weight Kimi and MiMo models), ChatGPT
  subscription models through the runner, and local embedding servers.
- **New chat models:** Claude Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5 and Fable 5.1, each also as a subscription
  `-bridge` model; GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna and GPT-5.6 Sol, Terra and Luna, each also as a
  ChatGPT subscription `-codex-bridge` model; Gemini 3.8 Flash, 3.7 Flash and 3.5 Flash-Lite; Grok 4.7, 4.6 and 4.5;
  GLM-5.3, GLM-5.3 Flash, GLM-5.3 FlashX and GLM-5.2; DeepSeek Flash (V4.1); MiMo V2.6 Pro, V2.6 Flash and V2.6 Pro
  UltraSpeed; Kimi K3 and K2.6 on Moonshot; Kimi K3 and K3 Fast on Fireworks; MiMo V2.6 Pro, V2.6 Flash, v2.5 Pro and
  v2.5 on GMICloud.
- **New image models:** GPT Image 2.5 Flare and Sunburst, Gemini 3 Pro Image and Grok Imagine 2.0.
- The catalog now lists 85 chat, 8 image and 5 embedding models (1.4.0 listed 46, 4 and 3).
- **OpenAI fast mode:** a per-session setting runs every call on a supporting OpenAI model in the fast tier (fast-tier
  prices on the direct API, the priority tier on a ChatGPT subscription), and each reply records whether the provider
  applied it.
- **Reasoning defaults:** every model with an effort ladder starts new sessions at its highest effort, and a **Worker
  effort** setting governs background runs.
- **Model menus** list a provider only when it has a key or a sign-in.
- **Starting models that run on any server.** A session with nothing to inherit (a new campaign's first session, a
  wizard or lorebook-import campaign, a session outside any campaign) starts on Claude Opus 4.6 when the account can use
  it and on a model it can use otherwise, and its background models and retrieval embeddings follow the account's
  providers. A server with only an OpenAI key, for example, runs its pipeline with no further settings.
  `DEFAULT_MODEL_ID` still replaces the chat defaults.

### Changed

- **Interface.** A navigation rail replaces the sidebar footer and becomes a bottom bar on phones. Every dialog shares
  one frame: Escape closes it, Tab stays inside it, and focus returns to where it was. One icon set replaces the emoji
  and glyphs, controls share one size scale, the fonts (DM Sans and JetBrains Mono) are served by the app, and panels
  and dialogs load on first use. The transcript, the composer and the top bar were restyled. New brand art: the logo
  and mark, a favicon and app icons, a sign-in backdrop and illustrated empty states.
- **Context Engine dialog.** The Engine popover became a dialog in plain language, with an **Injected text** viewer that
  shows the exact text each setting adds to the prompt. The seven world-authority settings are read-only for
  non-administrators.
- **Settings live on the session.** Campaign-level context settings are gone, and every setting is per session. A new
  session in a campaign copies the settings of that campaign's newest session; other new sessions start from the
  server's defaults.
- **New built-in session defaults:** hybrid retrieval, a 42,000-token retrieval budget, a 120,000-token context budget,
  70 guaranteed messages, the Dramatist on at standard intensity with world ticks applied automatically, OpenAI fast
  mode on, world stance 4 and depiction tier 3. Existing sessions keep their values.
- **Session lifetime.** Sessions end at a fixed daily hour (3 AM by default, in the time zone set in Server settings;
  a new server takes the zone of the browser that ran setup) with at least four hours of runway, and every request
  renews the cookie. A session that lapses while the app is open shows a sign-in overlay and keeps unsent text.
- **Per-campaign pipeline lanes.** Every campaign has its own fast lane (rolling diffs, the thread tracker, drive
  updates, world ticks) and slow lane (audits), so one campaign's work no longer waits behind another's.
- **Background work.** Each model call a worker makes has a deadline (30 minutes, 120 for audits), transient errors
  are retried, and a run whose model setting no longer resolves fails with a visible error.
- **Faster turns.** Context scoring runs on a worker thread, keyword matching builds no regular expression per key, and
  helper calls overlap context assembly. `CONTEXT_SCORING_WORKER=0` and `CHAT_PRECOMPOSER_OVERLAP=0` restore the
  earlier behaviour.
- **Every message can be edited.** Earlier versions locked the messages the pipeline had already reviewed.
- **Alerts.** The Events badge counts failures only; informational notes moved to a Notices tab.
- **`TRUST_PROXY`** accepts `1`, `true`, `yes` or `on`, a hop count, or an Express trust list, and a variable set to an
  empty value counts as unset.
- **Containers** run node as their main process, so `docker stop` reaches the shutdown handlers directly.
- **Images** no longer contain `.env` files, `docs/`, `deploy/`, `certs/`, nested `data` and `dist` folders, or test
  output.

### Fixed

- With the default Compose setup (a separate worker), automatic pipeline runs were never queued, and worker runs could
  not read users' stored provider keys.
- Semantic retrieval mixed lorebook entries from different campaigns that used the same embedding model.
- Gemini requests sent no safety settings, and a filter block arrived as an empty reply. Blocks now raise a clear error.
- Bulk lorebook actions could reach entries outside the campaign on screen.
- The database did not enforce its foreign keys.

### Security

- Sign-in lockout counts failures per username regardless of letter case: five failures lock that username for 30
  minutes, beside a looser limit per address. Earlier versions counted each spelling of a username separately.
- Forgot-password and its resend answer the same way for real and unknown usernames: the same masked address
  (`***@***`), the same send limit and the same delay.
- Custom endpoints must use `https://`, and the private-address check also catches IPv4 addresses written inside IPv6
  forms (IPv4-mapped, IPv4-compatible, NAT64 and 6to4).
- Changing a password removes trusted devices, new passwords are limited to 72 bytes (bcrypt's real limit), and
  registration, password reset, two-factor, email change and setup requests are rate-limited per address.
- Request bodies are limited before they are parsed: 64 KB for sign-in and setup, 1 MB by default, and 75 MB for chat,
  lorebook and wizard import once the sign-in is checked.
- Server secrets (the SendGrid key, the SMTP password and authenticator secrets) are stored encrypted like provider keys
  and never sent back to the browser. Each authenticator code works once.
- The fonts are served by the app, and the Content-Security-Policy no longer allows Google's font hosts.
- The logger redacts credential-shaped fields up to two levels deep, and the token of an invite link never reaches the
  logs (`[token]` takes its place in logged paths).
- Second-factor codes have a per-account budget across sign-in challenges: ten wrong codes in 15 minutes, from any
  address, stop the account's codes being accepted for the rest of that window, and administrators see an event.
- Deleting an account retries the Claude and ChatGPT sign-out three times, reports one that still fails, and the API
  removes any sign-in left behind by a deleted account shortly after each start and every six hours.
- The trusted-device cookie is `Secure` only over HTTPS the server can verify (directly, or reported by a proxy that
  `TRUST_PROXY` trusts); a client's own `X-Forwarded-Proto` no longer counts. Responses no longer carry
  `X-Powered-By`, and a client's `X-Request-Id` is kept only when it is a plain token of up to 128 characters (the
  server assigns one otherwise).
- The Codex sidecar creates its replay logs with mode 0600.

### Removed

- The demo account in the default configuration (`SEED_DEMO_USER` now defaults to `0`).
- The approval-gated campaign review (**Update Seed**, with Approve, Retry and Abandon). Campaign Audit replaces it.
- Campaign-level context settings (the campaign editor's Context tab and pipeline model). Settings live on the session.
- The separately hosted Claude subscription bridge and its `CLAUDE_CODE_BRIDGE_URL` and `CLAUDE_CODE_BRIDGE_SECRET`
  variables.
- The one-way importer from the original JSON-on-disk implementation.
- The Codex sidecar's unversioned API; it answers only `/v2`.
- The rolling-diff switch and cadence settings, which nothing read.
- Models: GPT-5, GPT-5 Mini, GPT-5 Nano and GPT-5.1 Codex Mini (on OpenAI's deprecation schedule), DeepSeek V4 Flash
  (retired by DeepSeek; DeepSeek Flash V4.1 replaces it), and MiMo v2.5 and v2.5 Pro on Xiaomi's own API (being shut
  down by Xiaomi; GMICloud still serves them).
- The request to Google Fonts.

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
- **Wizard defaults are now self-contained.** `apps/api/src/domain/wizard/wizardDefaults.ts` previously read `server/wizard-defaults.js` at runtime from the old implementation's directory, since removed. The `DEFAULT_EXAMPLE_SYSTEM_PROMPT` template literal is now inlined directly. **V2 has no remaining runtime dependency on V1 files.**
- **10 confirmed-orphan exports deleted**: `isTestEnv` (`config/paths.ts`), `extractColdStart` (`domain/campaigns/coldStart.ts`), `healthResponseSchema`/`HealthResponse`, `restoreSessionRequestSchema`/`startSessionFromCampaignResponseSchema`, `pipelineRunKindSchema`/`PipelineRunKind`, `codexOkResponseSchema`/`CodexOkResponse`, `embeddingProviderIdSchema`/`EmbeddingProviderId`, `sceneChanged()` (`domain/chat/sceneParser.ts`), `renderHighlightedText()` (`features/chat/SessionConversation.tsx`), the deprecated bare `requireAuth` handler. The unused `streamControllers` map and `abortSessionResponse` export in `chatApi.ts` also removed.

**Net code change across the 2026-05-20 security + reliability + dead-code pass: −5,330 lines of TypeScript across −32 files (−11.5%).**

### F2 pipeline reliability (historical — the F2 typed-edits codebase has since been removed)

These fixes shipped in April 2026. The F2 typed-edits subsystem itself was subsequently identified as orphaned (the V3 lorebook engine and V4 raw-text prompts had superseded it without removing the dead code) and removed in the 2026-05-20 dead-code purge. Listed here for engineering-history continuity.

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
- **Example documents** — replaced the placeholder examples with a 1,409-line state seed plus a 633-line system prompt that exercises every template feature end-to-end.
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
