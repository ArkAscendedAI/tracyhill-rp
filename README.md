# TracyHill RP

**A self-hosted, multi-user LLM chat client built for long-form collaborative fiction and roleplaying.**

TracyHill RP is what you get when you stop fighting your chat client and start building one around the way long-form roleplay actually works: persistent campaigns, structured world state, version-controlled system prompts, multi-provider model switching mid-conversation, and all the admin surface you need to run it for a small group of friends or a private community.

Every API call is proxied server-side so provider keys never touch the browser. SQLite-backed, Docker-deployable, MIT licensed, and genuinely designed to be cloned and run — the default `docker compose up` produces a working instance with a demo admin account you can log into immediately.

---

## Feature Tour

### Multi-provider chat
Every major frontier provider, with native support for each one's differences instead of flattening them to a lowest common denominator.

| Provider | Models | Highlights |
|---|---|---|
| **Anthropic** | Claude Fable 5 (always-on adaptive thinking), Opus 4.8 / 4.7 (adaptive-only thinking), Opus 4.6 (1M ctx, 128K out), Sonnet 4.6, Haiku 4.5 | Off / Budget / Adaptive thinking, effort control (Low → Max), prompt caching with per-session TTL, fast-mode toggle, categorized refusal cards, serving-model transparency |
| **OpenAI** | GPT-5.5 / 5.5 Pro, GPT-5.4 / 5.4 Pro / Mini / Nano, GPT-5.1 / Codex-Mini, GPT-5 / Mini / Nano, GPT-4.1 / Mini, GPT Chat (Instant) | Reasoning models via the Responses API with visible thinking summaries (effort None → XHigh per model), Chat Completions for non-reasoning, cached-input accounting |
| **Google** | Gemini 3.1 Pro, Gemini 3.5 Flash, Gemini 3.1 Flash-Lite, Gemini 2.5 Pro / Flash / Flash-Lite | Thinking levels on 3.x, thinking budget on 2.5 (true off where the API permits, honest always-on where it doesn't), thinking-token accounting, long-context tier pricing in the cost overlay, native PDF + image support |
| **xAI** | Grok 4.3, Grok 4.20 (R/NR) | 1M context, streamed reasoning summaries, reasoning-effort control incl. true non-reasoning, cached-input pricing, long-context tier pricing |
| **DeepSeek** | DeepSeek V4 Pro / Flash | On/off thinking toggle with streamed reasoning content, cache-hit pricing, 1M context / 384K output |
| **z.ai** | GLM-5.1, GLM-5, GLM-5 Turbo, GLM-4.7, GLM-4.7 FlashX, GLM-4.6, GLM-4.5 | On/off thinking toggle with streamed reasoning content, cache-hit pricing |
| **Xiaomi** | MiMo v2.5 Pro, MiMo v2.5 | 1M context, on/off thinking toggle with streamed reasoning content, cached-input pricing |
| **Claude Code bridge** (optional) | Claude Fable 5 / Opus 4.8 / 4.7 / 4.6 / Sonnet 4.6 / Haiku 4.5 — `-bridge` model variants | Route chat through a [Claude Code SDK](https://docs.claude.com/en/docs/claude-code/overview) bridge that you host yourself, so chat usage bills against your Claude subscription instead of per-token Anthropic API |
| **Custom endpoints** | OpenRouter, LM Studio, Ollama, Together AI, Groq, vLLM, anything OpenAI-compatible | Multiple named endpoints, per-endpoint API keys, custom model lists with configurable context/output limits, Chat Completions or Responses API formats |

Switch models mid-conversation with a single click. The custom dropdown groups models by provider with expandable submenus.

### Campaign pipeline
TracyHill RP treats long-form roleplay as a **stateful document workflow**, not an ephemeral chat. Every campaign has:
- A **system prompt** (the persistent identity of the session)
- A **lorebook** (a structured, queryable knowledge base — characters, locations, factions, events, world rules)
- **Version history** — every system prompt change is archived in perpetuity

A queue-driven worker runs the post-session update flow automatically:

- **Rolling diff** — after each session-turn batch crosses a character threshold, a small model writes incremental lorebook edits (create / update / disable entries) directly from the transcript.
- **Repetition detection** — periodically scans for narrative repetition and proposes anti-repetition rules (ban / limit / vary tiers) that get injected into the system prompt.
- **Sysprompt audit** — periodically reviews the system prompt for drift against the live lorebook state and rewrites it surgically.
- **Lorebook consolidation** — periodically dedupes and merges related entries.
- **Lorebook archival** — entries that haven't been activated in many turns get compressed into a synopsis "trigger" that's still searchable but no longer carries narrative cost. Their full content stays in cold storage and gets lazily inflated back into context when the trigger activates.
- **Narrative thread tracking** — a worker maintains a live index of open story threads (status, last progress, next beat) as an always-in-context lorebook entry, with a full detail entry per thread retrieved on demand. Resolved threads fall off through a grace window and graduate into the event history, so the index stays focused on what's still live.

Per-campaign serialization with mutual exclusion means jobs queue cleanly; the UI shows a running/queued pill with elapsed timers. Pipeline state persists to disk so a worker restart doesn't lose progress.

### Context engine

Every turn assembles its system-prompt context from the lorebook through a multi-signal retrieval pipeline rather than a fixed-shape document. Per turn:

- **Keyword activation** — entries with matching trigger keys are pulled in, with configurable scan depth and sticky/cooldown behavior.
- **Semantic activation** — embedding cosine similarity against the user's turn (OpenAI `text-embedding-3-large` / `-3-small` or Google `gemini-embedding-2`, configurable per campaign).
- **HyDE query expansion** — a small model rewrites the user's turn into a hypothetical-answer query to widen semantic recall.
- **Synonym key expansion** — when an entry is created or updated by the rolling-diff worker, its key list is automatically widened with synonym variations so it activates on alternate phrasings.
- **Researcher pass** — a small LLM picks contextually relevant entries the keyword + semantic passes missed.
- **Scene presence override** — characters physically present in the current scene always get their firmware loaded regardless of activation scores.
- **Budget pruning** — entries scored and fitted into a configurable token budget (16K default). Guaranteed entries (constant, sticky, scene-present) always make it; the rest compete on score.

**Scene markers** — assistant responses emit `[SCENE]` blocks tagging location, present characters, present-but-unaware characters, in-world date/time, and notes. The parser strips the block from visible output and persists it as structured data. Downstream turns get a `<scene_state>` context injection enforcing knowledge boundaries across scene transitions, plus per-character **epistemic scoping** via `known_by` tags on lorebook entries (Scene Knowledge vs Narrator-Only Knowledge sections in the prompt).

**Scene presence validator** — a small model post-checks each assistant turn for present-character drift and surfaces a three-way UI resolution (accept the validator's pick, accept the model's pick, or regenerate the response). The same pass reconciles per-character **attire state**, surfaced as a `<character_attire>` context block on subsequent turns with freshness annotation so wardrobe continuity survives long scenes.

**Anti-repetition rules** — tiered `ban` / `limit` / `vary` rules injected into the chat system prompt to push back against narrative loops. Auto-dedup, archival, and budget cap.

A per-turn **Context Preview panel** in the chat surface shows exactly what was activated, what scored highest, and what got dropped for budget — so prompt-engineering becomes legible instead of a black box.

### Campaign wizard
Starting a new campaign from scratch? The wizard is an LLM-guided interactive conversation that gathers your premise, main character, NPCs, world, and rules, then produces **four documents** (state seed v0, system prompt, seed update template, system-prompt update template) plus a brand new session pre-loaded with them. The wizard is multi-model — you pick which provider drives it.

### Chat power tools
- **Markdown rendering** with code blocks, dialogue highlighting, copy buttons
- **File attachments** — text, PDFs, images (base64 for chat providers that support vision)
- **Image generation** — GPT Image 2, Gemini 3.1 Flash Image, Grok Imagine, GLM Image — all at max native resolution
- **Multi-session streaming** — stream multiple sessions concurrently, sidebar shows live dots
- **Browser-disconnect recovery** — the server accumulates streams independently and saves the result even if you close the tab mid-response
- **Output-truncation detection** — visible warning if a response hit `max_tokens`
- **Serving-model transparency** — a badge whenever the provider reports a response was produced by a different model than the one requested (provider-side substitutions and fallbacks are never silent)
- **Full token accounting** — input / output / reasoning / cache read / cache write tokens per message, with per-model pricing (including long-context tiers and cache-hit rates) rolled into a live session cost estimate
- **Background-task observability** — embedding, retrieval, validator, and pipeline failures are recorded as system events and surfaced in the UI instead of failing silently
- **Concurrent message editing** — edit, delete, resend, regenerate, cut-after, copy
- **Search** — global search across all sessions plus in-session `Ctrl+F`
- **Session organization** — nested folders with drag-and-drop, recycle bin with soft delete + auto-purge
- **Prompt templates** — reusable, inserted as attachment chips, not pasted text
- **Per-user runtime defaults** — cache TTL, thinking mode, effort, temperature, auto-scroll, font size

### Admin surface
- **Users** — create / delete users, reset passwords, toggle admin role, view any user's sessions
- **Provider keys** — set server-level fallback keys, see per-provider status, manage custom endpoints
- **Storage** — disk usage stats, image count and size, bulk image purge
- **Audit** — database-backed audit log of admin/auth/pipeline/wizard actions
- **Claude Code bridge** — drive a remote Claude Code agent from an in-app dialog (optional, disabled by default)
- **Codex bridge** — drive a remote OpenAI Codex CLI session from an in-app dialog (optional, disabled by default)

### Security
- Per-user session cookies (`httpOnly`, `secure`, `sameSite:lax`), signed with a rotation-safe secret
- Server-side API proxy — provider keys never reach the browser
- Provider keys encrypted at rest with AES-256-GCM, key derived from `SESSION_SECRET` via HKDF
- Content-Security-Policy (`script-src 'self'`, no `unsafe-inline`, no `unsafe-eval`), HSTS, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy
- CSRF Origin + `X-Requested-With` custom-header validation on every state-changing request
- Per-IP and per-username rate limiting on auth endpoints (login: 3 fails / 30 min lockout; MFA / forgot-password / registration: 10 / 15 min)
- Password complexity enforcement, bcrypt cost-12 hashing, timing-safe code comparison
- Session regeneration + explicit save on login (prevents session fixation, prevents new-session-ID loss on early disconnect)
- Multi-factor authentication via email, trust-device cookies (30-day, SHA-256-hashed at rest), forgot-password flow with **constant-shape response** (no account enumeration)
- IP allowlist (gates upstream TCP peer, not end users — right layer for reverse-proxy restriction)
- **SSRF-gated custom endpoints** — custom `baseUrl` values must parse as `http(s)://` with no userinfo, resolve to a public IP (loopback / RFC1918 / link-local / CGNAT / reserved IPv4 + ::1 / fc00::/7 / fe80::/10 / multicast IPv6 all rejected). Operators can opt-in to specific LAN hostnames via `CUSTOM_ENDPOINT_ALLOW_HOSTS`. Upstream error bodies from custom endpoints are stripped so the SSE error event can't be used as a readback channel.
- Bounded upstream error-body reads (16 KB cap) prevent a misbehaving provider from pinning RAM
- Upstream request timeouts prevent resource leaks from hung provider requests
- Admin cannot delete or demote the last admin account
- Cascade-clean account deletion (audit log retained on purpose; all per-user data + active HTTP sessions evicted)
- Non-root container user (UID 1001), atomic file writes, sanitized error responses (never leak stack traces)

### What you don't need to run it
- **No external database.** SQLite with WAL journaling, one file under `./data/`.
- **No Redis.** Sessions are stored in the same SQLite database — durable across restarts, no extra service.
- **No Kafka.** The worker polls the DB directly for pipeline/wizard jobs.
- **No S3.** Images live as flat files in `./data/v2/images/`.
- **No separate auth service.** Everything is in-process.

---

## A note on content

TracyHill RP is a general-purpose collaborative-fiction tool. The tone, content rating, and subject matter of any given campaign are defined entirely by the user via the wizard — anywhere from light-rated PG family-friendly adventure to adult literary fiction with mature themes. The application itself does not filter, rate, or moderate content; what the model writes is a function of (1) the system prompt and lorebook the user authored, (2) the configured provider's own usage policies, and (3) whatever moderation you choose to layer on top.

The wizard ships with a sample campaign template intended to illustrate the structural format (scene rules, character profiles, voice modes, voice firmware) rather than to set a tone — operators are expected to replace or adjust it to suit their audience. If you're running a public or multi-user instance, treat the wizard template, the chosen providers, and the user agreement as a single content-policy surface.

---

## Quick Start

You need Docker with the `docker compose` plugin. That's it.

```bash
# 1. Clone
git clone https://github.com/ArkAscendedAI/tracyhill-rp.git
cd tracyhill-rp

# 2. Copy the example env (SESSION_SECRET auto-generates on first boot if left blank)
cp .env.example .env
# Optionally pre-set a secret: echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env

# 3. Build and start
docker compose up -d

# 4. Open http://localhost:3000 and log in
#    Username: demo
#    Password: demo-pass
```

That's the full setup. You're logged in as a demo admin. Go to **Settings → Provider Keys** to add API keys for whichever providers you want to use, and start a session.

> **Change the demo password before exposing this to the internet.** The default credentials are public knowledge — that's the whole point of "works out of the box." Go to **Settings → Change Password** as soon as you're in, or set `SEED_DEMO_USER=0` in `.env` and create users manually.

### Verify it's healthy

```bash
curl http://localhost:3000/api/system/health
# {"status":"ok","db":"ok","images":"ok"}
```

### Tear it down

```bash
docker compose down          # stops containers, keeps data
docker compose down -v       # stops and also wipes volumes (but not ./data which is a bind mount)
rm -rf ./data                # wipes all users, sessions, images — total reset
```

---

## Installation Options

### Option A: Docker Compose (recommended)

The shipped `docker-compose.yml` builds a multi-stage image, starts the API container, starts the API and a dedicated worker container, bind-mounts `./data` for persistence, sets up log rotation, and wires a healthcheck on `/api/system/health`.

See [Quick Start](#quick-start). This is the intended path for almost every user.

### Option B: Local development (npm)

If you want to hack on the code, run each workspace in dev mode with hot reload:

```bash
# Install dependencies (uses npm workspaces)
npm install

# Run migrations once
# (the API auto-migrates on first boot, but if you want to run explicitly:)
npm run --workspace packages/db migrate

# In three terminals:
npm run dev:api      # apps/api on port 4010 (or PORT env), auto-restart on changes
npm run dev:worker   # apps/worker, same
npm run dev:web      # apps/web on port 5173, Vite dev server with HMR
```

Copy `.env.example` to `.env` at the repo root and set `SESSION_SECRET`. The API reads it from there.

Open `http://localhost:5173` — the Vite dev server proxies `/api/*` to the API on 3000.

### Option C: Build from source + run with Node

```bash
npm install
npm run build              # typechecks + builds every workspace
npm run start:api          # runs apps/api/src/index.ts via node with tsx loader
# in another terminal:
npm run start:worker       # runs apps/worker/src/index.ts
```

Expects environment variables to be set in the shell (e.g. via `set -a; source .env; set +a`).

---

## Configuration

A minimal working `.env` needs exactly one line:

```bash
SESSION_SECRET=your-64-hex-random-string-here
```

Everything else has sensible defaults. [`ENVIRONMENT.md`](ENVIRONMENT.md) documents every single variable — name, default, what it does, and when you'd change it. The quick reference:

| Category | Key variables |
|---|---|
| **Core** | `SESSION_SECRET` (required), `PORT`, `HOST_PORT`, `DB_FILE`, `LOG_LEVEL`, `TRUST_PROXY`, `ALLOWED_IPS` |
| **Providers** (all optional fallbacks) | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY` |
| **Email** (for MFA/registration) | `SENDGRID_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` |
| **Bootstrap** | `SEED_DEMO_USER`, `DEMO_USERNAME`, `DEMO_PASSWORD` |
| **Mocking** | `MOCK_PROVIDER`, `EXPOSE_AUTH_CODES` |

See [`ENVIRONMENT.md`](ENVIRONMENT.md) for the full reference.

---

## Adding Provider Keys

There are two ways to configure API keys:

### Per-user (recommended)

Log in as an admin. Open **Settings → Provider Keys**. Paste your key for each provider you want to use. Keys are stored per-user in the database and are never exposed to the browser — the frontend only sees a redacted preview and status.

This is the right approach if:
- You want different users to use their own accounts with each provider
- You don't want to restart the server to rotate a key
- You don't want to put keys in environment variables

### Server fallback (env)

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. in `.env`. These become **fallback keys** — used when a user hasn't configured their own. User-supplied keys always override the env-level fallback.

This is useful if:
- You're running a single-user instance and don't want to click through the UI
- You want to share a team API budget without each user managing their own keys
- You're running an internal tool with a shared billing account

Both approaches can coexist.

### Custom OpenAI-compatible endpoints

Any provider that speaks OpenAI's API format (Chat Completions or Responses) can be added at runtime via **Settings → Provider Keys → Custom Endpoints**:

- **Name** (display label, e.g. "Local LM Studio")
- **Base URL** (e.g. `http://192.168.1.10:1234/v1`)
- **API Key** (leave blank for local/no-auth servers)
- **API Format** (`chat-completions` or `responses`)
- **Auth Header** (`Bearer`, `api-key`, or `none`)
- **Models** — define which models your endpoint serves, each with its context and output limits

Custom endpoints participate in browser-disconnect recovery, streaming, and per-message model switching just like built-in providers.

---

## Architecture

TracyHill RP is a TypeScript monorepo using npm workspaces, with each concern isolated in its own package or app:

```
apps/
  api/        Express HTTP API. Auth, streaming proxy, workspace CRUD,
              admin routes, pipeline/wizard orchestration, SPA serving.
  web/        React 18 + Vite frontend. Session UI, composer, dialogs,
              streaming rendering, markdown, drag-drop, admin panels.
  worker/     Background job runner. Polls SQLite for pipeline + wizard
              jobs, executes LLM calls, persists results.

packages/
  contracts/        Zod schemas shared between frontend and backend.
                    Any API request/response body is defined here.
  db/               SQLite schema (Drizzle ORM), migrations, client
                    factory. Better-sqlite3 with WAL journaling.
  logging/          Structured pino logger with child-logger pattern,
                    request-ID middleware, audit event helpers.
  model-catalog/    The per-provider model registry with capabilities,
                    context windows, output limits, thinking/reasoning
                    metadata. Single source of truth for what works.
  provider-runtime/ Provider dispatch. Abstracts each provider's wire
                    format (Anthropic, OpenAI Responses/Chat Completions,
                    Gemini, xAI, z.ai, DeepSeek, custom endpoints) behind
                    a normalized stream contract.
  test-fixtures/    Deterministic test data used by every workspace's
                    test suite.

tools/
  codex-agent-service/  Optional OpenAI Codex bridge agent service.

docs/v2/      Per-slice engineering documentation. Each slice doc
              describes a vertical feature: its goals, DB changes, API
              surface, frontend changes, and tests.
```

The API and worker share the same SQLite database. Frontend streams from the API; the API proxies to providers or enqueues worker jobs. The worker updates the DB as jobs progress and the API's polling endpoints surface that state to the frontend without needing websockets.

### Why SQLite

Because for a self-hosted, single-host, small-scale service this is boring and correct. Better-sqlite3 + WAL gives you:
- Atomic writes without a separate transaction log daemon
- Concurrent reads with single-writer semantics (fine for chat workloads)
- Backup with `cp` or `sqlite3 .backup`
- No network hop between API and DB
- One file to move, copy, replicate, or restore

If you outgrow SQLite, the DB layer is isolated in `packages/db` behind Drizzle — swapping for Postgres is a mechanical change, not an architectural one.

### Data model at a glance

```
users                       — account + role, password hash, email, MFA state,
                              trusted devices, agreement timestamps
user_preferences            — per-user sidebar state, active session, runtime defaults
folders                     — nested session folders, drag-drop ordering
sessions                    — session metadata (name, model, runtime config,
                              folder/campaign linkage, soft-delete, scene state)
messages                    — append-only message log per session
message_attachments         — text/image/PDF attachments referenced by messages
campaigns                   — campaign records with system prompt, context defaults,
                              character roster, version counter
campaign_versions           — archived system prompt per approved pipeline run
lorebook_entries            — structured world-knowledge entries activated per turn
lorebook_entry_embeddings   — per-entry vectors for semantic retrieval
lorebook_activation_state   — per-session activation tracking (sticky, cooldown,
                              last-activated turn)
pipeline_runs               — pipeline execution state (persisted across restarts)
pipeline_run_artifacts      — raw LLM I/O capture for the pipeline workers
wizard_runs                 — wizard execution state + generated documents
wizard_templates            — per-user wizard example templates (4 tabs)
custom_endpoints            — OpenAI-compatible custom provider records
provider_keys               — encrypted per-user API keys per provider
audit_events                — database-backed audit log of admin/auth/mutation actions
generated_images            — metadata for images generated via the image-gen APIs
prompt_templates            — reusable prompt template library per user
pending_assistant_messages  — in-flight assistant messages awaiting completion
http_sessions               — SQLite-backed session store (durable across restarts)
```

Full schema lives in `packages/db/src/schema/`.

---

## Development

### Running tests

Every workspace ships vitest suites. Run all tests from the repo root:

```bash
npm test                  # runs vitest across every workspace
npm run typecheck         # TypeScript typecheck across every workspace
npm run build             # builds every workspace (tsc + vite)
```

Per-workspace runs are also supported:

```bash
npm test --workspace apps/api
npm test --workspace packages/provider-runtime
```

End-to-end browser tests live in `apps/web/e2e/`:

```bash
npm run test:e2e
```

### Adding a new provider

1. Add the wire implementation to `packages/provider-runtime/src/<provider>.ts` following the existing pattern (`anthropic.ts`, `openai.ts`, etc.). Each provider exports a `callModel()` function and a stream parser.
2. Register the provider in `packages/provider-runtime/src/registry.ts`.
3. Add the model catalog entries to `packages/model-catalog/src/<provider>.ts` with `maxOut`, `ctx`, reasoning/thinking flags, and any other per-model capabilities.
4. Add the provider enum to `packages/contracts/src/provider.ts`.
5. Add the env var to `.env.example` and `ENVIRONMENT.md`.
6. Write tests in `packages/provider-runtime/src/<provider>.test.ts` using the test fixtures.

### Database migrations

Migrations live in `packages/db/migrations/` and are auto-applied at API startup. To add a new one:

```bash
cd packages/db
npm run generate   # generates a new migration from schema changes
npm run migrate    # applies pending migrations
```

### Style notes

- Strict TypeScript everywhere. `any` needs a comment explaining why.
- Contracts are Zod schemas, typed via `z.infer<>`, never hand-written interfaces.
- Every API route has a controller, a schema, and a test.
- Every feature has a per-slice doc under `docs/v2/`.

---

## Deployment

### Behind a reverse proxy

The shipped Compose file listens on `0.0.0.0:3000`. Production deployments should:

1. Put nginx / Caddy / Traefik in front and terminate TLS there.
2. Set `TRUST_PROXY=true` in `.env` so the API honors `X-Forwarded-For`.
3. Consider `ALLOWED_IPS=<your-proxy-ip>` to reject direct connections that bypass the proxy.
4. Tighten `HOST_PORT` to `127.0.0.1:3000` in Compose so only the proxy can reach the API.
5. Disable `SEED_DEMO_USER` (`SEED_DEMO_USER=0`) and create accounts manually via the admin panel.

### Data persistence

The shipped Compose file bind-mounts `./data` to `/app/data` inside the container. Everything stateful lives there:

```
./data/
  v2/
    tracyhill-rp-v2.sqlite      # main database
    tracyhill-rp-v2.sqlite-wal  # WAL journal (needed for consistent backup)
    tracyhill-rp-v2.sqlite-shm  # shared memory file
    images/                     # generated + uploaded images
```

To back up, take a consistent SQLite snapshot and tar the images dir:

```bash
sqlite3 ./data/v2/tracyhill-rp-v2.sqlite ".backup ./data/backup.sqlite"
tar czf tracyhill-rp-backup-$(date +%F).tar.gz \
    ./data/backup.sqlite ./data/v2/images
rm ./data/backup.sqlite
```

Don't just `cp` the .sqlite file while the app is running — that can produce a corrupt copy due to WAL. Always use `.backup` or stop the container first.

### Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

Migrations run automatically at API startup. `./data` persists across restarts.

### Updating the demo password after first boot

1. Log in as `demo` / `demo-pass`
2. Go to **Settings → Change Password**
3. Set a strong password
4. (Optional) disable auto-seeding: edit `.env`, set `SEED_DEMO_USER=0`, `docker compose up -d` to recreate the container

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, branch etiquette, and how to propose features.

The short version: fork, hack, write tests, open a PR. Every change should land with at least one test, a lint-clean build, and a typecheck-clean tree.

---

## License

MIT. See [`LICENSE`](LICENSE).

TracyHill RP is a personal project released as open source. It ships as-is with no warranty. If you run it, you're running it on your own infrastructure, under your own keys, for your own users — the maintainer makes no guarantees about uptime, security, or fitness for any particular purpose. Read the LICENSE before deploying to anything you care about.

---

## Acknowledgments

TracyHill RP was built for a specific use case (long-form collaborative roleplay with a small group) and released open source in the hope that it's useful to anyone else running into the same frustrations with off-the-shelf chat clients. If you find it useful, a star on GitHub is appreciated. If you find a bug, an issue or a PR is even better.
