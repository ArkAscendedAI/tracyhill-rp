# TracyHill RP

**A self-hosted, multi-user LLM chat client built for long-form collaborative fiction and roleplaying.**

TracyHill RP is built around the way long-form roleplay works: persistent campaigns, structured world state, version-controlled system prompts, switching between providers' models mid-conversation, and the administration you need to run it for a small group of friends or a private community.

The server makes every provider call, so provider keys never reach the browser. It is SQLite-backed, deploys with Docker and is MIT licensed. `docker compose up -d` on a fresh clone gives a working instance, and a first-run setup page creates your administrator account.

---

## Feature Tour

### Multi-provider chat
Ten API providers, sign-ins to your own Claude and ChatGPT subscriptions, and any OpenAI-compatible endpoint. Each provider has its own runtime, so its thinking controls, caching and usage reporting follow that provider's API.

| Provider | Models | Highlights |
|---|---|---|
| **Anthropic** | Claude Fable 5.1 / Fable 5 (always-on adaptive thinking), Claude Opus 5.5 (1M ctx / 128K out, always-on adaptive thinking, 0.05× cache reads), Claude Opus 5 (1M ctx / 128K out, thinking on by default with an honest Off dial), Claude Sonnet 5.5 (thinking on by default; Off skips thinking before the answer), Claude Sonnet 5, Opus 4.8 / 4.7 (adaptive-only thinking), Opus 4.6 (1M ctx, 128K out), Sonnet 4.6, Haiku 4.5 | Off / Budget / Adaptive thinking, effort control (Low → Max), prompt caching with per-session TTL, fast-mode toggle (Opus 4.8 / 5 / 5.5), categorized refusal cards, serving-model transparency |
| **OpenAI** | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol / Luna, GPT-5.6 Sol / Terra / Luna, GPT-5.5 / 5.5 Pro, GPT-5.4 / 5.4 Pro / Mini / Nano, GPT-5.1, GPT-4.1 / Mini, GPT Chat (Instant) | Reasoning models via the Responses API with visible thinking summaries (effort None → Max where supported), Chat Completions for the non-reasoning models, cached-input accounting, fast mode on GPT-6 Astra, 6.1 Sol, 6 Sol and 6 Luna (one Engine dial applies it to the composer, the context helpers and every pipeline worker) |
| **Google** | Gemini 3.8 / 3.7 Flash, Gemini 3.5 Flash / Flash-Lite, Gemini 3.1 Pro, Gemini 3.1 Flash-Lite, Gemini 2.5 Pro / Flash / Flash-Lite | Thinking levels on 3.x, thinking budget on 2.5 (true off where the API permits, honest always-on where it doesn't), explicit safety settings with loud filter failures, thinking-token accounting, long-context tier pricing in the cost overlay, native PDF + image support |
| **xAI** | Grok 4.7, Grok 4.6, Grok 4.5, Grok 4.3, Grok 4.20 (R/NR) | Streamed reasoning summaries, model-aware reasoning-effort control, cached-input pricing, long-context tier pricing |
| **DeepSeek** | DeepSeek V4 Pro, DeepSeek Flash (V4.1) | On/off thinking toggle with a low / high / max effort ladder while thinking, streamed reasoning content, cache-hit pricing, 1M context / 384K output |
| **z.ai** | GLM-5.3 / 5.3 Flash / 5.3 FlashX (always-on reasoning), GLM-5.2, GLM-5.1, GLM-5, GLM-5 Turbo, GLM-4.7, GLM-4.7 FlashX, GLM-4.6, GLM-4.5 | On/off thinking toggle with streamed reasoning content, cache-hit pricing |
| **Xiaomi** | MiMo V2.6 Pro, MiMo V2.6 Flash, MiMo V2.6 Pro UltraSpeed | 1M context, on/off thinking toggle with streamed reasoning content, cached-input pricing |
| **Moonshot AI** | Kimi K3 (1M context, always-on reasoning with a low/high/max effort ladder), Kimi K2.6 | Automatic context caching with cache-hit pricing and per-conversation cache affinity; on/off thinking toggle on K2.6 with streamed reasoning content |
| **Fireworks AI** | Kimi K3, Kimi K3 Fast | The open-weight Kimi K3 through Fireworks AI's API instead of Moonshot's own: a reasoning-effort ladder, a temperature dial (honored alongside effort), streamed reasoning content |
| **GMICloud** | MiMo V2.6 Pro / Flash, MiMo v2.5 Pro / v2.5 | The open-weight MiMo models through GMICloud's API instead of Xiaomi's own: thinking on by default with a true off switch, streamed reasoning content |
| **Claude subscription** (built in) | Claude Fable 5.1 / Fable 5 / Opus 5.5 / Opus 5 / Sonnet 5.5 / Sonnet 5 / Opus 4.8 / 4.7 / 4.6 / Sonnet 4.6 / Haiku 4.5, as `-bridge` model variants | Each user signs in to their own Claude subscription under **Options → Providers → Subscriptions** (or uses a server-wide sign-in an administrator connected, see [Administration](#administration)); turns run through the official, unmodified [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) program inside the bundled runner container. The models appear in the pickers once a sign-in is connected |
| **ChatGPT subscription** (built in) | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol / Luna, GPT-5.6 Sol / Terra / Luna, as `-codex-bridge` variants | Each user signs in to their own ChatGPT subscription with a device code (or uses a server-wide sign-in). Main chat, the wizard, context helpers, validators and every automatic pipeline call run through the official [Codex App Server](https://developers.openai.com/codex/app-server/) in the same runner. Streamed text and thinking, images, cancellation, usage and served-model reporting are preserved, and the OpenAI fast dial requests the App Server's fast tier on all seven models |
| **Custom endpoints** | OpenRouter, Together AI, Groq, vLLM, LM Studio, Ollama, anything OpenAI-compatible | Multiple named endpoints, per-endpoint API keys, custom model lists with configurable context/output limits, Chat Completions or Responses API formats. Every endpoint URL must use `https://`; a server on your own network (LM Studio or Ollama, for example) also needs its host name in `CUSTOM_ENDPOINT_ALLOW_HOSTS` |

The model roster changes as providers release and retire models. `packages/model-catalog/src/index.ts` is the source of truth for every model, limit and price, and [`CHANGELOG.md`](CHANGELOG.md) lists the changes by release.

Switch models mid-conversation with a single click. The custom dropdown groups models by provider with expandable submenus.

### Campaign pipeline
TracyHill RP treats long-form roleplay as a **stateful document workflow**. Every campaign has:
- A **system prompt** (the persistent identity of the session)
- A **lorebook** (a structured, queryable knowledge base: characters, locations, factions, events, world rules)
- **Version history**: every system prompt change archives the previous version

A queue-driven worker maintains campaign state from the replies the player keeps. A reply counts once the player's next message settles it:

- **Rolling diff:** after the session's new transcript crosses a character threshold, a small model writes incremental lorebook edits (create / update / disable entries) directly from the transcript.
- **Repetition detection:** periodically scans for narrative repetition and proposes anti-repetition rules (ban / limit / vary tiers) that are injected into the system prompt.
- **Sysprompt audit:** periodically reviews the system prompt for drift against the live lorebook state and rewrites it surgically.
- **Lorebook consolidation:** periodically dedupes and merges related entries.
- **Lorebook archival:** entries that haven't been activated in many turns are compressed into a synopsis "trigger" that stays searchable but no longer carries narrative cost. Their full content stays in cold storage and is inflated back into context when the trigger activates.
- **Narrative thread tracking:** a worker maintains a live index of open story threads (status, last progress, next beat) as an always-in-context lorebook entry, with a full detail entry per thread retrieved on demand. Resolved threads fall off through a grace window and graduate into the event history, so the index stays focused on what's still live.

Every campaign has its own two lanes, drained side by side: a fast lane for these jobs and a slow lane for the long-running Campaign Audit, so one campaign's long jobs do not delay another's. Version-checked writes and audit/ruling collision guards protect canon; the UI shows running and queued state. Jobs and resumable audit checkpoints persist in SQLite.

### Context engine

Every turn assembles its context from the lorebook through a multi-signal retrieval pipeline. Per turn:

- **Keyword activation:** entries with matching trigger keys are pulled in, with configurable scan depth and sticky/cooldown behavior.
- **Semantic activation:** embedding cosine similarity against the user's turn (OpenAI `text-embedding-3-large` / `-3-small`, Google `gemini-embedding-2`, or a self-hosted `local:` model such as `nomic-embed-text-v1.5` / `bge-m3` behind `LOCAL_EMBEDDING_URL`, described in [`ENVIRONMENT.md`](ENVIRONMENT.md)), selectable per session in the Engine panel. When no key reaches the chosen embedding model's provider, retrieval falls back to keywords and records a warning.
- **HyDE query expansion:** a helper model rewrites the user's turn into a hypothetical-answer query to widen semantic recall.
- **Synonym key expansion:** when the rolling-diff worker creates or updates an entry, it widens the entry's keys with synonyms and alternate phrasings so the entry activates on those too.
- **Researcher pass:** a helper model picks relevant entries the keyword and semantic passes missed.
- **Scene presence override:** characters physically present in the current scene always get their entries loaded, whatever their activation scores.
- **Budget pruning:** entries are scored and fitted into a configurable retrieval budget (42,000 tokens by default). Constant entries and the entries of characters present in the scene always go in. Referenced thread entries are guaranteed up to their own token cap (6,000 tokens by default). Everything else, sticky entries included, competes for the rest of the budget.

**Scene markers:** assistant responses emit `[SCENE]` blocks tagging location, present characters, present-but-unaware characters, in-world date/time, and notes. The parser strips the block from visible output and persists it as structured data. Downstream turns get a `<scene_state>` context injection enforcing knowledge boundaries across scene transitions, plus per-character **epistemic scoping** via `known_by` tags on lorebook entries (Scene Knowledge and Narrator-Only Knowledge sections in the prompt).

**Scene presence validator:** a small model post-checks each assistant turn for present-character drift and surfaces a three-way UI resolution (accept the validator's pick, accept the model's pick, or regenerate the response). The same pass reconciles per-character **attire state**, surfaced as a `<character_attire>` context block on later turns with a freshness note, so wardrobe continuity survives long scenes.

**Anti-repetition rules:** tiered `ban` / `limit` / `vary` rules injected into the chat system prompt to push back against narrative loops, with automatic dedup, archival and a cap on the rule count.

A per-turn **Context Preview** in the chat surface shows what was activated, what scored highest, and what was dropped for budget.

### Campaign wizard
The wizard is a guided conversation with a model of your choice. It gathers your premise, main character, NPCs, world and rules, then produces a **system prompt plus a structured lorebook corpus** (characters, locations, factions and world lore, with per-character drive sheets and a seeded antagonist scheme) and opens a new session loaded with them. The thread tracker owns thread entries during play. If the chosen model's provider has no key configured, the run fails with a message saying so. The empty chat area's **New Campaign Wizard** button starts it.

Already have a SillyTavern lorebook? **Import SillyTavern Compatible Lorebook** (under the wizard button) turns a World Info file, or a character card saved as JSON, into a campaign the same way. The model never rewrites an imported entry: each entry keeps its text (with the `{{user}}` and `{{char}}` names filled in) and its SillyTavern trigger settings, and the wizard's checks can only remove a sentence that breaks its rules. The wizard sorts the entries into characters, locations, factions, events, lore and rules, gives each character starting attire, drives and (for an antagonist) a sealed scheme, can add the character sections the book lacks, and writes the system prompt and any rule entries the book is missing. You review the result before anything is created.

### Beyond the basics

Everything above is the core loop. Later releases added more on top: autonomous NPC drive sheets and offscreen world ticks (Living World), a world-event authority that arms complications from live campaign state (the Dramatist, on by default for new sessions), server-adjudicated contested outcomes with a consequence ledger (Adversarial World), a fully automated full-history Campaign Audit, message variants (swipes), per-entry lorebook revision history, a per-character voice and pacing layer (Character Engine), and a refusal-prevention layer for the composers that need one (Content honesty, see [A note on content](#a-note-on-content)). Each has its own group in a session's Engine panel, and [`CHANGELOG.md`](CHANGELOG.md) describes them by feature area.

### Chat power tools
- **Markdown rendering** with code blocks, dialogue highlighting and copy buttons
- **File attachments:** text, PDFs and images (base64 for chat providers that support vision), stored in the database with their message
- **Image generation:** GPT Image 2 and GPT Image 2.5 Flare / Sunburst, Gemini 3.1 Flash Image and Gemini 3 Pro Image, Grok Imagine and Grok Imagine 2.0, GLM Image
- **Multi-session streaming:** stream several sessions at once; the sidebar marks each session that is streaming
- **Browser-disconnect recovery:** the server accumulates streams independently and saves the result even if you close the tab mid-response
- **Output-truncation detection:** a visible warning when a response hit the model's output limit
- **Serving-model transparency:** a badge whenever the provider reports that a different model than the one requested produced the response, so provider-side substitutions and fallbacks are never silent
- **Full token accounting:** input, output, reasoning, cache-read and cache-write tokens per message, with per-model pricing (including long-context tiers and cache-hit rates) rolled into a live session cost estimate
- **Background-task observability:** embedding, retrieval, validator and pipeline failures are recorded as system events and shown in the UI
- **Message actions:** edit, delete, resend, regenerate (a new variant beside the old one), cut after a message, copy. A cut or resend that would remove more than two later messages asks you to confirm how many go, and a page showing an out-of-date transcript is refused and reloads instead of cutting messages it never loaded
- **Search:** global search across all sessions plus in-session `Ctrl+F`
- **Session organization:** nested folders with drag-and-drop, and a recycle bin that purges deleted sessions after 30 days
- **Prompt templates:** reusable, inserted as attachment chips
- **Per-session runtime controls:** cache TTL, thinking mode, effort, temperature, auto-scroll

### Administration
Administrators find these under **Options → Admin**:

- **Users:** create and delete accounts, reset passwords, change roles, view a user's sessions, and reset someone's two-step sign-in after a lost phone. **Invite Links** makes one-time sign-up links (a role, an optional fixed username, 1 to 30 days) that work with sign-up off and without email.
- **Server settings**, changed in the browser without editing files or restarting:
  - **Accounts:** sign-up Off (the default on a new server) or Open, which needs working email; whether sign-up asks people to accept the terms; the terms and privacy text.
  - **Two-factor:** Off, Optional or Required, with an authenticator app and email codes as the methods.
  - **Email:** SendGrid or SMTP. Email counts as working only after a test email gets through, and sign-up, forgot-password and email codes stay unavailable until then.
  - **Shared keys:** server-wide API keys, and server-wide Claude or ChatGPT sign-ins, for every account that has none of its own. You pay for what those accounts use. The page warns that Anthropic or OpenAI may ban a subscription shared this way.
  - **Sessions:** the daily sign-out hour and its time zone.
  - **New sessions:** the starting world stance and depiction tier (see [A note on content](#a-note-on-content)).
  - **Server:** a read-only view of `TRUST_PROXY`, `ALLOWED_IPS` and which coding panels are set up.

  Email and shared keys can also come from `.env`; a value set there wins and shows locked on the page.
- **Storage:** disk usage, image count and size, and a bulk purge of generated images.
- **Audit:** a database-backed log of account, administration, settings, pipeline and wizard actions.
- **Coding panels:** full-screen Claude Code, Codex and Kimi (K3) workspaces that drive agent services running outside this app. None is set up automatically; see [Coding panels](#coding-panels-optional).

### Security
- **Provider keys stay on the server.** The browser never receives them, and status views show only a redacted preview. Stored provider and custom-endpoint keys, the shared keys, the email secrets and authenticator secrets are encrypted with AES-256-GCM under a key derived (HKDF) from the deployment's session secret.
- **Sessions:** `httpOnly`, `sameSite=lax` cookies (`secure` when `TRUST_PROXY` is on), stored in SQLite and regenerated at sign-in. Sessions end at the daily sign-out hour with at least four hours of runway, and a lapsed session shows a sign-in overlay over the still-open app, so an unsent draft survives.
- **Two-step sign-in:** Off, Optional or Required, chosen by the administrator. People use an authenticator app (any TOTP app, with ten one-time recovery codes per setup) or email codes, as the administrator allows, and can trust a device for 30 days; an administrator can reset a lost phone. A recovery command covers the case where nobody can sign in ([Recovering access](#recovering-access)).
- **Passwords:** bcrypt with cost 12, at least eight characters with upper and lower case and a digit, at most 72 bytes; changing a password revokes trusted devices.
- **Rate limits:** sign-in locks for 30 minutes after 5 failures for one username or 30 from one address. The registration, invite, password-reset, two-step and email-change flows each lock an address out for 15 minutes after 10 requests; each emailed code allows 5 attempts, and at most 6 codes go out per 10 minutes. Ten wrong first-run setup codes lock an address out of setup for 15 minutes.
- **No account enumeration:** forgot-password answers with the same response whether or not the account exists.
- **CSRF:** a state-changing request must carry an `Origin` that matches the host; one without `Origin` must carry `X-Requested-With`.
- **Headers:** a Content-Security-Policy with `script-src 'self'` (no inline or eval scripts; inline styles are allowed), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a Referrer-Policy and a Permissions-Policy, plus HSTS when `TRUST_PROXY` is on.
- **IP allowlist:** `ALLOWED_IPS` checks the connecting peer (your reverse proxy, when there is one) against exact addresses.
- **Custom endpoints** must use `https://` without credentials in the URL and resolve to a public address unless their host is listed in `CUSTOM_ENDPOINT_ALLOW_HOSTS`. Their upstream error bodies are not passed back to the browser.
- **Upstream limits:** provider error bodies are read up to 16 KB, and provider requests time out.
- The last administrator cannot be deleted or demoted. Deleting an account removes its data and signs out its sessions; the audit log is kept.
- **Containers:** the API, worker and runner run as UID 1001. Only the one-shot init service runs as root, to prepare `./data` and the secrets. Error responses never include stack traces.

[`SECURITY.md`](SECURITY.md) describes these mechanisms in full and explains how to report a vulnerability.

### What you don't need to run it
- **No external database.** SQLite with WAL journaling, one database file under `./data/`.
- **No Redis.** Sessions are stored in the same SQLite database, so they survive restarts without an extra service.
- **No message queue.** The worker polls the database for pipeline and wizard jobs.
- **No object storage.** Generated images are flat files in `./data/v2/images/`; uploaded attachments are stored in the database.
- **No separate auth service.** Everything is in-process.

---

## A note on content

TracyHill RP is a general-purpose collaborative-fiction tool, for anything from family-friendly adventure to adult fiction with mature themes. It does not filter or moderate what the model writes. That follows from the campaign's system prompt and lorebook, the provider's own usage policies, and these settings, which an operator should understand before inviting anyone:

- **World stance** (0 Indulgent, 1 Earned, 2 Indifferent, 3 Hostile, 4 Predatory) sets how causality resolves relative to the player's character, from resolving in their favor to converging on their weakest point.
- **Depiction tier** (0 None, 1 Direct, 2 Visceral, 3 Unflinching) sets how explicitly consequences are rendered. Each tier is a floor the prompt asks the model to meet; tier 3 asks for extreme material at the intensity the story's causality produces.
- **Content honesty** is a refusal-prevention layer. In a campaign session whose composer is a Google model, **Kimi K3** or **Kimi K3 (Fireworks)**, it tells the model that the fiction is written for a consenting adult audience and that everything is allowed inside it. It is on by default and can be switched off for a session in its Engine panel.
- Chat requests to Google's Gemini models switch off the safety filters Google lets callers adjust; Google's fixed protections still apply.

On a new server, new sessions start at the highest values, world stance 4 and depiction tier 3, unless they inherit a campaign's settings. Only administrators can change these two: for one session in its Engine panel, and for every new session in **Admin: Server settings → New sessions**. Lower them if children use your server. A server that already had accounts before this setting existed keeps starting new sessions at stance 1 and tier 0.

The wizard works from an example system prompt that each account can replace (the Campaigns panel's **Wizard** tab, **Template Library**). The shipped example is the system prompt of a dark fantasy survival campaign. It is the structural guide for the wizard's interview and generation, and it carries that campaign's tone, so replace it if your audience needs something else. If you run a public or multi-user instance, treat the content settings, the wizard example, the chosen providers and your terms (Admin: Server settings → Accounts) as one content-policy surface.

---

## Quick Start

You need Docker with the `docker compose` plugin.

```bash
# 1. Clone
git clone https://github.com/ArkAscendedAI/tracyhill-rp.git
cd tracyhill-rp

# 2. Build and start. Nothing to configure first: the first boot creates this
#    deployment's own random session secret in ./data/v2/session.secret.
docker compose up -d

# 3. Read the one-time setup code from the log
docker compose logs tracyhill-rp | grep -A 2 "setup code"

# 4. Open http://localhost:3000 and follow the setup page
```

That's the full setup. The setup page asks for the code first, so nobody else who reaches a new instance can claim it. It then creates your administrator account and asks you to connect at least one model provider: an API key, or a sign-in to your own Claude or ChatGPT subscription (you can skip this step and connect one later). Add more at any time from **Options → Providers**. Create accounts for other people, or invite links they redeem themselves, from **Admin: Users**. A new code is printed each time the server restarts, until the first account exists, and only the most recent one works; [`ENVIRONMENT.md`](ENVIRONMENT.md#first-run-setup) has the details.

Server behavior such as sign-up, two-step sign-in, email and shared keys is set in **Admin: Server settings**. For the settings that live in the environment, copy `.env.example` to `.env`, edit it, and run `docker compose up -d` again.

> **Use HTTPS before anyone reaches it over a network.** The app itself serves plain HTTP, so passwords and API keys would cross the network unencrypted. Put a reverse proxy in front that provides HTTPS (see [Behind a reverse proxy](#behind-a-reverse-proxy)); the setup page warns when it is opened over plain HTTP from another machine.

### Verify it's healthy

```bash
curl http://localhost:3000/api/system/health
# {"ok":true,"service":"tracyhill-rp-v2-api","now":"2026-…","topology":"split","worker":{"ok":true,"beatAt":"…","staleSeconds":3}}
# (`worker` reports the dedicated worker's liveness heartbeat; it is omitted under INLINE_WORKERS=1)
```

`docker compose ps` shows the API, the worker and the runner as healthy once they are up; the init service has exited by then.

### Tear it down

```bash
docker compose down        # stops the containers; data and sign-ins stay
docker compose down -v     # also deletes the named volumes: `subscriptions` (every Claude and ChatGPT sign-in) and `secrets`
sudo rm -rf ./data         # deletes the database, the images and the session secret (on Linux the folder belongs to UID 1001)
```

A total reset takes the last two commands together. The init service writes the `secrets` volume again on the next start.

---

## Installation Options

### Option A: Docker Compose (recommended)

The shipped `docker-compose.yml` builds two images from the multi-stage `Dockerfile`: the app, and a separate runner image that installs the official Claude Code and Codex programs at build time. It starts four services:

- `tracyhill-rp-init`: a one-shot step that runs as root before the others start. It hands a root-owned `./data` to the app user (UID 1001), creates the deployment's session secret on first boot (an operator's `SESSION_SECRET` wins, and a stored secret is never replaced), writes the runner its derived secret on the `secrets` volume, and exits.
- `tracyhill-rp`: the API, which also serves the web app, published on port 3000 (`HOST_PORT`), with a healthcheck on `/api/system/health`.
- `tracyhill-rp-worker`: the background worker for the pipeline and the wizard, with a heartbeat healthcheck.
- `tracyhill-rp-runner`: the subscription runner. It publishes no port (only the API and the worker reach it), keeps each person's Claude and ChatGPT sign-in in its own home on the `subscriptions` volume, and runs under a memory limit (`RUNNER_MEMORY_LIMIT`, 3 GB by default).

The API and the worker share the `./data` bind mount, and every service's logs rotate (10 MB × 5 files by default). See [Quick Start](#quick-start). This is the intended path for almost every user.

### Option B: Local development (npm)

For working on the code. You need Node 20 (the version in the Docker image) and npm; when no prebuilt `better-sqlite3` binary matches your platform, its install compiles one, which needs a C++ toolchain.

```bash
npm ci                          # every workspace
npm --prefix apps/runner ci     # the subscription runner: plain JavaScript, outside the npm workspaces
```

The npm scripts do not read `.env`, and each workspace script runs in its own folder, so every terminal needs the same absolute paths and the same secret. Generate a secret once with `openssl rand -hex 32`, then start each terminal at the repository root with:

```bash
export SESSION_SECRET=<your secret> INLINE_WORKERS=0 RUNNER_URL=http://127.0.0.1:7710 \
  DB_FILE="$PWD/data/dev/rp.sqlite" IMAGE_DIR="$PWD/data/dev/images" RUNNER_DATA_DIR="$PWD/data/dev/runner"
```

and run one of these in each:

```bash
npm run dev:api        # the API on port 4010, restarted on changes
npm run dev:worker     # the background worker
npm run dev:web        # Vite on http://127.0.0.1:3010 with hot reload; it proxies /api to port 4010
npm run start:runner   # optional: the subscription runner on port 7710, for the Claude and ChatGPT models
```

Open `http://127.0.0.1:3010`. The API prints the first-run setup code in its terminal. For development only: `MOCK_PROVIDER=1` replaces the chat, image, pipeline and wizard model calls with canned responses (embeddings still call their provider), and `SEED_DEMO_USER=1` creates a `demo` / `demo-pass` administrator on an empty database in place of first-run setup.

### Option C: Build and run with Node

Run these from the repository root, so the API and the worker share `data/v2/`: the database, and the session secret the API creates on its first start (start the API first). Outside Docker the API listens on port 4010 unless `PORT` is set, and these scripts do not read `.env` either.

```bash
npm ci
npm run build                          # typechecks the workspaces and builds the web app into apps/web/dist
INLINE_WORKERS=0 npm run start:api     # the API, serving the built web app
npm run start:worker                   # in a second terminal: the background worker
```

Without `INLINE_WORKERS=0` and the second terminal, the API runs the background jobs in its own process. For the Claude and ChatGPT subscription models, also run the runner: `npm --prefix apps/runner ci`, then give the API, the worker and `npm run start:runner` the same `SESSION_SECRET` (the value in `data/v2/session.secret`), set `RUNNER_DATA_DIR` to a writable folder for the runner, and set `RUNNER_URL=http://127.0.0.1:7710` for the API and the worker. The runner does not read `data/v2/session.secret` itself.

---

## Configuration

Nothing is required. Every variable has a working default, `.env` is optional, and the first boot generates the deployment's own random session secret (set `SESSION_SECRET` only to carry over an existing deployment's). The one-shot init service prepares `./data` and the secrets before the app starts, so a fresh clone works on Linux without creating or chowning anything by hand.

Sign-up, two-step sign-in, email, shared keys, the daily sign-out time and the starting content settings live in **Admin: Server settings**. The environment holds what the server needs before it starts. [`ENVIRONMENT.md`](ENVIRONMENT.md) documents every variable; the quick reference:

| Category | Key variables |
|---|---|
| **Core** | `SESSION_SECRET` (optional: generated on first boot), `PORT`, `HOST_PORT`, `DB_FILE`, `LOG_LEVEL`, `TRUST_PROXY`, `ALLOWED_IPS`, `CUSTOM_ENDPOINT_ALLOW_HOSTS`, `DEFAULT_MODEL_ID` |
| **Providers** (optional server-wide keys) | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `XIAOMI_API_KEY`, `MOONSHOT_API_KEY`, `FIREWORKS_API_KEY`, `GMICLOUD_API_KEY` |
| **Local embeddings** (optional) | `LOCAL_EMBEDDING_URL`, `LOCAL_EMBEDDING_KEY` |
| **Subscription runner** (built in, nothing to set) | `RUNNER_URL`, `RUNNER_SECRET` (derived from the session secret when blank), `RUNNER_MEMORY_LIMIT` |
| **Optional coding panels** | `CLAUDE_CODE_*`, `KIMI_CODE_*`, `CODEX_*` |
| **Email** (optional; usually set in Admin: Server settings → Email) | `SENDGRID_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` |
| **Development only** (never on a server other people reach) | `SEED_DEMO_USER`, `DEMO_USERNAME`, `DEMO_PASSWORD`, `MOCK_PROVIDER`, `EXPOSE_AUTH_CODES` |

A new session starts on Claude Opus 4.6 when the account can use it (through an Anthropic key or a Claude sign-in), and its context helpers and background workers on the Claude models their Engine-panel dials ship with. When the account cannot use those, a session that has no earlier session of its campaign to inherit from starts on a model the account can use instead, its helper and worker dials follow the same rule, and its retrieval embeddings move from Google's `gemini-embedding-2` to OpenAI's (or to a local embeddings server when `LOCAL_EMBEDDING_URL` is set). Later sessions of a campaign inherit the first session's choices, every dial can be changed in the Engine panel, and `DEFAULT_MODEL_ID` replaces the chat defaults everywhere. [`ENVIRONMENT.md`](ENVIRONMENT.md) lists the order a fallback model is chosen in.

---

## Adding Providers

People connect providers themselves in **Options → Providers**, which has three areas: API keys, subscription sign-ins and custom endpoints. An administrator can also provide keys and sign-ins for the whole server.

### Per-user API keys (recommended)

Open **Options → Providers** and paste your key for each provider you want to use. Keys are stored encrypted per account; after saving, the dialog shows only a redacted preview and the key's status.

This is the right approach if:
- You want each person to use, and pay for, their own provider account
- You don't want to put keys in environment variables

### Server-wide keys

Add them in **Admin: Server settings → Shared keys** (stored encrypted; a change applies from the next turn), or set the provider variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the rest) in `.env`, which win over the page and show there as locked. An account with its own key for a provider uses its own; every other account uses the server's, and its Providers dialog says so. Server-wide keys are open to every account on the server, so whoever runs the server pays for everyone's use, including anyone who signs up while sign-up is Open.

This is useful if:
- You're running a single-user instance
- You want to share a team API budget without each user managing their own keys

Both approaches can coexist.

### Subscriptions (Claude and ChatGPT)

The **Subscriptions** area has one card per provider. Each user signs in with their own account:

- **Claude:** Connect → open the Anthropic sign-in page → paste the code it shows → Finish sign-in.
- **ChatGPT:** Connect → open the device sign-in page → enter the one-time code; the card finishes on its own.
  Device-code sign-in may need enabling once in your ChatGPT security settings.

Once connected, the card shows the account and plan and offers **Log out**. The sign-in happens inside the bundled runner container, which keeps each user's credentials in its own home on the `subscriptions` volume; the app stores no token. The subscription models appear in the pickers only while a sign-in is connected, and every turn, helper and background job runs under the sign-in of the account that owns the session. The runner starts with `docker compose up` like everything else and needs no configuration.

An administrator can also connect a server-wide Claude or ChatGPT sign-in in **Admin: Server settings → Shared keys**, after ticking a box that acknowledges the risk: Anthropic and OpenAI may ban a subscription shared with other people. Accounts without a sign-in of their own then run their subscription turns on it.

### Custom OpenAI-compatible endpoints

Any provider that speaks OpenAI's API format (Chat Completions or Responses) can be added at runtime via **Options → Providers → Custom Endpoints**. Each account adds its own:

- **Name** (display label, e.g. "Local LM Studio")
- **Base URL** (e.g. `https://lmstudio.example.internal/v1`; it must use `https://` and resolve to a public address unless its host name is listed in `CUSTOM_ENDPOINT_ALLOW_HOSTS`)
- **API Key** (leave blank for local/no-auth servers)
- **API Format** (`chat-completions` or `responses`)
- **Auth Header** (`Bearer`, `api-key`, or `none`)
- **Models**: define which models your endpoint serves, each with its context and output limits

Custom endpoints participate in browser-disconnect recovery, streaming, and per-message model switching just like built-in providers.

---

## Coding panels (optional)

Administrators can open three full-screen coding workspaces from the **Coding** menu: **Claude Code**, **Codex** and **Kimi (K3)**. Each one drives an agent service that runs outside this app, on a machine you choose, and the app reaches it over HTTPS with a shared secret. None is set up automatically. Until a panel's host and secret are set, the Coding menu shows it greyed out (the whole menu when none is set up), its keyboard shortcut does nothing, and the server records an info event at boot. **Admin: Server settings → Server** shows which panels are set up.

| Panel | Agent service | Settings |
|---|---|---|
| Codex | `tools/codex-agent-service/` in this repository, which runs the official Codex App Server under that machine's own Codex sign-in | `CODEX_*` |
| Claude Code | A Claude Agent SDK service that speaks the panel's protocol; this repository does not include one (the API side is `apps/api/src/domain/claudeCode/`, the event contract `packages/contracts/src/claudeCode.ts`) | `CLAUDE_CODE_*` |
| Kimi (K3) | A service that speaks the Claude Code panel's protocol and serves Kimi K3; not included either | `KIMI_CODE_*` |

To turn a panel on: run its agent service with a TLS certificate, make that certificate (or the CA that issued it) readable inside the API container (for example with a volume in a `docker-compose.override.yml`) and point the panel's `*_CA_PATH` at it, set the panel's host and secret in `.env`, and run `docker compose up -d`. The panel turns on in the Coding menu. [`ENVIRONMENT.md`](ENVIRONMENT.md) lists each panel's variables.

The Codex service runs with `npm start` in its folder, on a machine where the Codex CLI is installed and signed in. It serves HTTPS on port 7701 (`AGENT_PORT`) with the certificate and key at `certs/agent-cert.pem` and `certs/agent-key.pem`, requires the shared secret (`AGENT_SECRET`), and accepts only the addresses in `ALLOWED_IPS` (loopback by default). Its workspaces are the home folder of the user that runs it and each folder under `~/projects`, unless `WORKSPACES_JSON` names others. In the panel's YOLO mode the agent has full access to that machine as that user, so run it under an account you are willing to hand over.

## Architecture

TracyHill RP is a TypeScript monorepo using npm workspaces, with each concern isolated in its own package or app:

```
apps/
  api/        Express HTTP API: auth, first-run setup, the streaming
              proxy, workspace CRUD, admin and server-settings routes,
              pipeline/wizard orchestration, SPA serving. Its
              src/deployment/ folder holds the init service and the
              operator commands (account recovery, email adoption).
  web/        React 18 + Vite frontend: session UI, composer, dialogs,
              streaming rendering, markdown, drag-drop, admin dialogs.
  worker/     Background job runner. Polls SQLite for pipeline and
              wizard jobs, makes the model calls, persists results.
  runner/     Subscription runner: plain JavaScript with its own
              package.json and lockfile, outside the npm workspaces.
              Hosts the official Claude Code and Codex programs, one
              home per user; the Claude and ChatGPT subscription
              models run here.

packages/
  contracts/        Zod schemas shared by the frontend and the backend
                    for the API's request and response bodies.
  db/               SQLite schema (Drizzle ORM), migrations, client
                    factory. better-sqlite3 with WAL journaling.
  logging/          Structured pino logger with credential redaction
                    and child loggers.
  model-catalog/    The per-provider model registry: capabilities,
                    context windows, output limits, thinking/reasoning
                    metadata and prices.
  provider-runtime/ Provider dispatch. Wraps each provider's wire format
                    (Anthropic, OpenAI Responses and Chat Completions,
                    Gemini, xAI, DeepSeek, z.ai, Xiaomi, Moonshot,
                    Fireworks, GMICloud, the Claude subscription runner,
                    custom endpoints) and the image providers behind a
                    normalized stream contract. The ChatGPT subscription
                    runtime lives in apps/api/src/domain/providerKeys/.

tools/
  codex-agent-service/  The Codex panel's agent service (plain JavaScript);
                        the runner image reuses its App Server client and
                        composer modules.
```

The API and the worker share the same SQLite database. Chat replies stream from the API to the browser as server-sent events; the API calls the providers directly, reaches the runner over the Compose network for subscription models, and queues background jobs for the worker. The worker updates the database as jobs progress, and the frontend polls the API for that state.

### Why SQLite

For a self-hosted, single-host, small-scale service, SQLite in WAL mode (through better-sqlite3) gives:
- Atomic transactions without a separate database server
- Concurrent reads with single-writer semantics, enough for chat workloads
- Consistent live backups with SQLite's `.backup`
- No network hop between the app and its database
- One database file to move, copy or restore

The code depends on it: the data layer calls the synchronous better-sqlite3 driver (through Drizzle and directly), the migrations are SQLite SQL, and message search uses SQLite's FTS5. Moving to another database would mean porting the data layer and the migrations.

### Data model at a glance

One SQLite database:

- **Accounts:** `users`, `user_preferences`, `user_two_factor`, `http_sessions` (the sign-in session store), `invites`, `provider_keys`, `custom_endpoints`, `provider_connections` (each subscription sign-in's state, never a token), `prompt_templates`.
- **Sessions and messages:** `folders`, `sessions`, `messages`, `message_attachments`, `message_context_snapshots`, `pending_assistant_messages` (disconnect recovery), `settled_assistant_ingestions` (canon-writer receipts), `generated_images`.
- **Campaigns:** `campaigns`, `campaign_versions`, `lorebook_entries` with `lorebook_entry_embeddings`, `lorebook_activation_state` and `lorebook_entry_revisions`, `character_attire` and `character_drives` (each with a history table), `scheduled_beats`, the adversarial-world tables (`active_threats`, `campaign_consequences`, `threat_clocks`), `pipeline_runs`, `audit_findings`, `wizard_runs`, `wizard_templates`.
- **Server:** `server_settings`, `server_subscription_connections`, `audit_events`, `system_events`, `service_heartbeats`.

The Drizzle declarations are under `packages/db/src/schema/` and the hand-written SQL migrations under `packages/db/migrations/`.

---

## Development

[Option B](#option-b-local-development-npm) above runs the app with hot reload. `npm run build` typechecks the workspaces and builds the web app, and `npm --prefix apps/runner run build` syntax-checks the runner.

### Adding a new provider

A service that speaks OpenAI's API format usually needs no code: add it as a [custom endpoint](#custom-openai-compatible-endpoints). A first-class provider touches these files:

1. `packages/provider-runtime/src/index.ts`: a runtime for its wire format, registered in `createRegistryChatRuntime` (the Fireworks and GMICloud runtimes are short examples). Keep cancellation, usage, reasoning and served-model reporting working.
2. `packages/model-catalog/src/index.ts`: its models, with their capabilities, limits and prices. The API checks the catalog's invariants (`packages/model-catalog/src/invariants.ts`) at startup.
3. `packages/contracts/src/providerKeys.ts`: the provider ID.
4. The key plumbing: the server key variable in `apps/api/src/config/env.ts` and `apps/worker/src/index.ts`, per-account keys in `apps/api/src/domain/providerKeys/`, the shared key in `apps/api/src/domain/settings/sharedKeys.ts`, and the entry in `apps/web/src/features/auth/providerList.ts` that the Providers dialog and first-run setup list.

Document a new environment variable in `.env.example` and `ENVIRONMENT.md`.

### Database migrations

Migrations are hand-written SQL files in `packages/db/migrations/`; there is no generate step. The API and the worker apply pending migrations when they start, through the same runner: each migration runs in its own transaction under SQLite's write lock, so whichever process starts first applies it and the other skips it. To add one:

1. Create `packages/db/migrations/NNNN_short_name.sql` with the next unused four-digit number. The runner applies files in name order and refuses to start on a name that is not `NNNN_name.sql` (letters, digits and underscores) or on two files that share a number.
2. Update the matching Drizzle declaration in `packages/db/src/schema/`, which the application code queries through, so it describes the same columns, defaults and indexes.

Never edit a migration that has been applied anywhere: the runner records each applied file name and skips it from then on, so the change would never run. Write a new migration instead.

### Style notes

- Strict TypeScript everywhere. `any` needs a comment explaining why.
- HTTP request and response bodies are Zod schemas in `packages/contracts`, with types inferred through `z.infer<>`.
- There is no ESLint config, so nothing enforces React's rules of hooks: keep every hook above the component's first early `return`.

---

## Deployment

### Behind a reverse proxy

The shipped Compose file publishes the app on port 3000 on every interface. Production deployments should:

1. Put nginx / Caddy / Traefik in front and terminate TLS there.
2. Set `TRUST_PROXY=true` in `.env`, so the API reads client addresses from `X-Forwarded-For`, marks cookies `secure` and sends HSTS. Use a number instead of `true` when there is more than one proxy hop.
3. Consider `ALLOWED_IPS=<your proxy's address>` to refuse direct connections that bypass the proxy (exact addresses; loopback is always allowed).
4. When the proxy runs on the same host, set `HOST_PORT=127.0.0.1:3000` in `.env` so only it can reach the app.

### Data persistence

The API and the worker keep everything stateful in `./data`, bind-mounted at `/app/data`:

```
./data/
  v2/
    tracyhill-rp-v2.sqlite      # the database: accounts, settings, campaigns, messages, uploads
    tracyhill-rp-v2.sqlite-wal  # WAL journal
    tracyhill-rp-v2.sqlite-shm  # shared-memory index
    images/                     # generated images
    session.secret              # the deployment's session secret (when SESSION_SECRET is not set)
```

Keep the session secret with the database. It signs the sign-in cookies and encrypts every stored key and secret, so a database restored without it signs everyone out and cannot read its provider keys, shared keys, email secrets or authenticator secrets. If you set `SESSION_SECRET` yourself, keep that value with your backups instead.

Claude and ChatGPT sign-ins live in the `subscriptions` named volume, outside `./data`, so a copy of `./data` never contains them. Back the volume up as well if people should stay signed in after a restore onto a new host; otherwise they sign in again. Compose names it after the project folder (`docker volume ls` shows `<folder>_subscriptions`). With the app stopped:

```bash
docker run --rm -v <folder>_subscriptions:/volume -v "$PWD":/backup alpine \
  tar czf /backup/tracyhill-rp-subscriptions-$(date +%F).tar.gz -C /volume .
```

To back up, either stop the app and archive the folder:

```bash
docker compose down
sudo tar czf tracyhill-rp-backup-$(date +%F).tar.gz ./data
docker compose up -d
```

or, while it runs, take a consistent SQLite snapshot (this needs the `sqlite3` command on the host) and archive it with the images and the secret:

```bash
sudo sqlite3 ./data/v2/tracyhill-rp-v2.sqlite ".backup '/tmp/tracyhill-rp.sqlite'"
sudo tar czf tracyhill-rp-backup-$(date +%F).tar.gz /tmp/tracyhill-rp.sqlite ./data/v2/images ./data/v2/session.secret
sudo rm /tmp/tracyhill-rp.sqlite
```

Don't `cp` the .sqlite file while the app is running: with WAL journaling that can produce a corrupt copy. `sudo` is there because on Linux `./data` belongs to the app's user (UID 1001).

### Upgrading

```bash
git fetch origin
git reset --hard origin/main
docker compose build
docker compose up -d
```

Each release replaces the repository's public history with a single new commit, so a plain `git pull` cannot merge it; `git reset --hard` moves your clone to the release instead. It discards changes to tracked files, while `.env`, `./data` and other untracked files stay. Migrations run automatically when the API and the worker start, and `./data` and the volumes persist. Read the upgrade notes in [`CHANGELOG.md`](CHANGELOG.md) before moving between releases. When you upgrade a deployment set up with an earlier version:

- If `.env` sets `SESSION_SECRET`, keep it. Without it the deployment generates a new secret, which signs everyone out and makes every stored key and secret unreadable.
- A database that already has accounts keeps its earlier behavior until you change it in **Admin: Server settings**: sign-up stays Open (it still needs working email), two-step sign-in stays Optional with email codes (and the authenticator app becomes available), the daily sign-out stays at 3 AM America/New_York, and new sessions start at world stance 1 and depiction tier 0.
- Remove `SEED_DEMO_USER=1` from `.env` if it is there, and change the password of a `demo` account that still has the published one, or delete the account.
- Email sent through `SENDGRID_API_KEY` keeps working and shows locked in Server settings. To move it into the settings without a gap, run this once the upgraded app is up:

  ```bash
  docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/adoptEnvEmailMain.ts --to <your address>
  ```

  It stores the values, sends a test email from the stored copy and exits 0 when that worked; then remove `SENDGRID_API_KEY`, `EMAIL_FROM` and `EMAIL_FROM_NAME` from `.env` and run `docker compose up -d`. Exit code 2 means the test failed: the values are stored but unproven, so keep the variables.

### Recovering access

An administrator resets another person's two-step sign-in in **Admin: Users** (Reset 2FA) and can set a new password there. When the administrator is the one locked out, run the recovery command in the app container:

```bash
docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name> --reset-two-factor
```

- `--reset-two-factor` removes that account's authenticator, recovery codes and trusted devices.
- `--new-password` sets a new random password, prints it once and signs the account out everywhere.
- `--two-factor-off` turns two-step sign-in off for the whole server (no `--user` needed); restart the app afterwards with `docker compose restart tracyhill-rp`.

Every run writes an audit row.

---

## Issues and security reports

Bug reports, feature requests and security problems are welcome as GitHub issues; for a security problem you can also message the maintainer directly. [`SECURITY.md`](SECURITY.md) lists what to include.

---

## License

MIT. See [`LICENSE`](LICENSE).

TracyHill RP is a personal project released as open source. It ships as-is with no warranty. If you run it, you're running it on your own infrastructure, under your own keys, for your own users; the maintainer makes no guarantees about uptime, security, or fitness for any particular purpose. Read the LICENSE before deploying to anything you care about.

---

## Acknowledgments

TracyHill RP was built for a specific use case (long-form collaborative roleplay with a small group) and released open source in the hope that it's useful to anyone else running into the same frustrations with off-the-shelf chat clients. If you find it useful, a star on GitHub is appreciated. If you find a bug, please open an issue.
