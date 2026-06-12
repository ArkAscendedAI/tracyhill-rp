# Environment Variables Reference

Every environment variable TracyHill RP reads, what it does, what happens if you don't set it, and how to pick a value.

For a quick copy-paste setup, see [`.env.example`](.env.example). For the big picture, see [`README.md`](README.md).

## How Configuration Works

TracyHill RP reads configuration from environment variables at startup. The shipped `docker-compose.yml` loads `.env` via `env_file:` and then templates each variable into the `api` and `worker` services. You can also export variables directly in your shell if you're running outside Docker (`npm run start:api`).

A handful of variables are **required** — the app will refuse to start without them. Most are optional with reasonable defaults. Provider API keys are entirely optional at the environment level because the app supports per-user keys via the in-app **Settings → Provider Keys** dialog.

Variables are grouped by what they control:

1. [Core runtime](#1-core-runtime) — ports, paths, logging, reverse-proxy behavior
2. [Chat providers](#2-chat-providers) — Anthropic, OpenAI, Google, xAI, z.ai, DeepSeek API keys
3. [Claude Code chat-provider bridge](#3-claude-code-chat-provider-bridge-optional) — route chat through a self-hosted Claude Code SDK so it bills against your Claude subscription
4. [Email](#4-email-sendgrid) — registration, MFA, password reset
5. [MFA](#5-mfa) — trust-device duration
6. [Claude Code admin bridge](#6-claude-code-admin-bridge-optional-admin-feature) — remote Claude Code agent driven from the in-app admin dialog (separate service from the chat-provider bridge above)
7. [Codex bridge](#7-codex-bridge-optional-admin-feature) — remote OpenAI Codex agent
8. [Development & bootstrap](#8-development--bootstrap) — demo user seeding, mock provider, auth-code exposure

---

## 1. Core Runtime

### `SESSION_SECRET`

Secret string used by `express-session` to sign session cookies **and** to derive the encryption key for provider API keys stored in the database (via HKDF). If it changes, all active sessions are invalidated AND all stored provider keys become unreadable until users re-enter them.

- **Default:** auto-generated on first boot and persisted to `data/v2/session.secret` (mode 0600). In Docker, `docker-compose.yml` requires it via `${SESSION_SECRET:?}` — set it in `.env` or Compose will refuse to start.
- **Generate with:** `openssl rand -hex 32`
- **Security:** treat as a production secret. Never commit to version control. Rotate only with the understanding that it invalidates sessions and encrypted keys.
- **Example:** `SESSION_SECRET=a1b2c3d4e5f6...` (64 hex chars)

### `PORT`

TCP port the API listens on **inside the container**.

- **Default:** `3000` (in Docker via compose). The code default when running outside Docker is `4010` — set `PORT=3000` explicitly if running with bare Node.
- **Example:** `PORT=3000`

### `HOST_PORT`

TCP port exposed on the **Docker host**. Use this to avoid collisions with other services on your machine. The app is reachable at `http://localhost:${HOST_PORT}`.

- **Default:** `3000`
- **Example:** `HOST_PORT=8080` (then open `http://localhost:8080`)

### `DB_FILE`

Absolute path to the SQLite database file **inside the container**. The default is under `/app/data` which is bind-mounted to `./data` on the host via `docker-compose.yml`, so the file survives container recreation.

- **Default:** `/app/data/v2/tracyhill-rp-v2.sqlite`
- **Notes:** The parent directory must exist and be writable by the container user. Don't change this unless you're also adjusting the volume mount.

### `IMAGE_DIR`

Absolute path where generated and uploaded images are stored. Also bind-mounted via `./data`.

- **Default:** `/app/data/v2/images`
- **Notes:** Flat directory of `{imageId}.png` / `.jpg` files — no nesting.

### `WEB_DIST_DIR`

Path to the built React frontend (`dist/`). The API serves these static files. In the shipped Dockerfile, the build stage compiles the web workspace to `/app/apps/web/dist` and the runtime stage copies it to the same location.

- **Default:** `/app/apps/web/dist`
- **When to change:** only if you're running the API against a custom frontend build.

### `INLINE_WORKERS`

If `1`, long-running background jobs (campaign pipeline, wizard generation) run **inside the API process** instead of the dedicated `tracyhill-rp-worker` container. Useful for single-host installs where the overhead of a second process isn't worth it.

- **Default:** `0` in Docker (compose sets it explicitly). **Warning:** the code treats any value other than `"0"` as enabled, including unset — so if running outside Docker without this variable, inline workers will be ON. Always set it explicitly.
- **Values:** `0` | `1`
- **Tradeoff:** Inline mode simplifies deployment but couples worker crashes to API downtime.

### `PIPELINE_POLL_MS`

How often the worker polls the database for new pipeline jobs, in milliseconds. Lower = faster job pickup, higher CPU baseline. Higher = lower baseline, slight job-pickup lag.

- **Default:** `1000`
- **Sensible range:** `250` (very responsive) to `5000` (very chill)

### `TRUST_PROXY`

Tells Express whether to trust `X-Forwarded-For` / `X-Forwarded-Proto` headers set by an upstream reverse proxy. Required for correct client-IP logging and rate limiting when running behind nginx, Caddy, Traefik, Cloudflare, etc.

- **Default:** `false`
- **Values:** `true` | `false`
- **Set to `true`** if you're running the app behind any reverse proxy. **Leave `false`** for direct exposure or local dev.

### `ALLOWED_IPS`

IP allowlist for **upstream TCP peer** — gates which hosts can connect to the API. This is the right knob for restricting which reverse-proxy hosts talk to the API, not for end-user IP gating (use the reverse proxy for that).

- **Default:** `*` in Docker (compose sets it). The code default when running outside Docker is empty string (which disables the allowlist, allowing all connections). Always set explicitly in production.
- **Values:** `*` | comma-separated list of IPs (e.g. `127.0.0.1,::1,10.0.0.5`)
- **Example:** `ALLOWED_IPS=127.0.0.1,::1` (localhost only)

### `CUSTOM_ENDPOINT_ALLOW_HOSTS`

Comma-separated allowlist of hostnames that bypass the **SSRF private-IP gate** when users configure a Custom Endpoint baseUrl. By default, every custom endpoint baseUrl must resolve to a public IP (loopback, RFC1918, link-local, CGNAT, and reserved ranges are rejected) — set this to opt-in to specific LAN endpoints (e.g. a local LM Studio or Ollama).

- **Default:** empty (no LAN endpoints allowed)
- **Values:** comma-separated list of lowercase hostnames (e.g. `lmstudio.local,ollama.lan`)
- **Example:** `CUSTOM_ENDPOINT_ALLOW_HOSTS=lmstudio.local,ollama.lan`
- **Security:** only add hostnames you control. Listed hosts are exempt from both the private-IP check and (effectively) the `https://` requirement. Listed hosts should still be configured carefully to avoid the API container reaching sensitive internal services.

### `LOG_LEVEL`

Structured JSON log verbosity.

- **Default:** `info`
- **Values:** `trace` | `debug` | `info` | `warn` | `error`
- **Production:** `info`. **Development:** `debug`. **Troubleshooting:** `trace`.

### `DOCKER_LOG_MAX_SIZE` / `DOCKER_LOG_MAX_FILE`

Log rotation for the Docker `json-file` driver. Prevents unbounded log growth from filling the host disk.

- **Defaults:** `10m` / `5` (keep up to 5 × 10 MB files per container)
- **Example:** `DOCKER_LOG_MAX_SIZE=50m`, `DOCKER_LOG_MAX_FILE=3`

---

## 2. Chat Providers

Every provider API key is **optional** at the environment level. If set, it becomes the **server fallback** — used when a user hasn't configured their own. If unset, users must enter their own key via **Settings → Provider Keys** before they can chat with that provider.

User-supplied keys are stored per-user in the database (never in the browser) and always override the server fallback for that user.

| Variable | Provider | Where to get a key |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude | [console.anthropic.com](https://console.anthropic.com/) |
| `DEEPSEEK_API_KEY` | DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/) |
| `GOOGLE_API_KEY` | Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `OPENAI_API_KEY` | OpenAI GPT / DALL-E / GPT Image | [platform.openai.com](https://platform.openai.com/api-keys) |
| `XAI_API_KEY` | xAI Grok | [console.x.ai](https://console.x.ai/) |
| `XIAOMI_API_KEY` | Xiaomi MiMo | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) |
| `ZAI_API_KEY` | z.ai GLM | [z.ai](https://z.ai/) |

You can also add **OpenAI-compatible custom endpoints** (OpenRouter, LM Studio, Ollama, Together AI, Groq, vLLM, etc.) through the in-app Custom Endpoints UI — no env vars needed.

---

## 3. Claude Code chat-provider bridge (optional)

Enables a synthetic "claude-code" chat provider whose `-bridge`-suffixed Claude models (`claude-opus-4-7-bridge`, `claude-opus-4-6-bridge`, `claude-sonnet-4-6-bridge`, `claude-haiku-4-5-bridge`) route every chat request through a **self-hosted [Claude Code SDK](https://docs.claude.com/en/docs/claude-code/overview) instance** instead of the Anthropic per-token API. If you have a Claude subscription you'd rather use for chat (and you have a Claude Code agent service exposed somewhere on a network the app can reach), point these variables at it and the bridge provider becomes available in the model picker.

Leave both blank to hide the bridge provider entirely.

### `CLAUDE_CODE_BRIDGE_URL`

Full base URL of the Claude Code SDK bridge service. The app appends `/v1/messages` and uses the Anthropic Messages API wire format.

- **Default:** none (provider disabled)
- **Example:** `CLAUDE_CODE_BRIDGE_URL=https://claude-bridge.internal.example.com`

### `CLAUDE_CODE_BRIDGE_SECRET`
  <!-- NOTE: distinct from CLAUDE_CODE_SECRET (agent-service/panel auth). The bridge's own BRIDGE_SECRET systemd env must match this value. -->

Pre-shared bearer secret for authenticating to the bridge.

- **Default:** none
- **Generate with:** `openssl rand -hex 32`

---

## 4. Email (SendGrid)

Required for self-service registration verification, forgot-password codes, and email-based MFA challenges. If you leave these blank, those flows will fail. Single-user installs that only use `SEED_DEMO_USER` can skip email entirely.

### `SENDGRID_API_KEY`

Your SendGrid API key.

- **Default:** none
- **Where to get:** [app.sendgrid.com](https://app.sendgrid.com/settings/api_keys)
- **Required scope:** Mail Send

### `EMAIL_FROM`

The `From:` address used on every outbound email. Must be a verified sender in your SendGrid account.

- **Default:** `noreply@example.com`
- **Example:** `EMAIL_FROM=noreply@yourdomain.com`

### `EMAIL_FROM_NAME`

The display name on the `From:` header.

- **Default:** `TracyHill RP`
- **Example:** `EMAIL_FROM_NAME=My Roleplay Server`

---

## 5. MFA

Trusted-device duration is currently hardcoded at 30 days. There is no `MFA_TRUST_DAYS` environment variable — this may become configurable in a future release.

---

## 6. Claude Code admin bridge (optional admin feature)

> **Note:** this is a different service from the chat-provider bridge in section 3 above. This one is the in-app admin dialog for driving a remote Claude Code agent (shell access, file edits, automation); the chat-provider bridge routes chat conversations through your Claude subscription. They can run side-by-side or independently.

The Claude Code admin bridge is an **admin-only** feature that lets a signed-in admin drive a remote Claude Code agent from an in-app dialog — useful for running shell commands, editing files, or kicking off automation on a server you also host the agent on.

Leave all `CLAUDE_CODE_*` variables blank to **disable** the feature entirely.

### `CLAUDE_CODE_HOST`

Hostname or IP of the remote Claude Code agent server.

- **Default:** none (feature disabled)
- **Example:** `CLAUDE_CODE_HOST=claude-agent.internal.example.com`

### `CLAUDE_CODE_PORT`

Port the Claude Code agent listens on.

- **Default:** `7700`

### `CLAUDE_CODE_SECRET`

Pre-shared secret for authenticating with the agent. Must match the secret configured on the agent side.

- **Default:** none
- **Generate with:** `openssl rand -hex 32`

### `CLAUDE_CODE_CA_PATH`

Path to a CA certificate bundle for verifying the agent's TLS cert when it uses a private CA. Relative paths resolve against `/app` inside the container.

- **Default:** none (use system CA store)
- **Example:** `CLAUDE_CODE_CA_PATH=certs/claude-agent.pem`

### `CLAUDE_CODE_SERVERNAME`

SNI hostname used during TLS handshake. Useful when the agent cert is issued for a name that doesn't match `CLAUDE_CODE_HOST`.

- **Default:** `claude-agent`

---

## 7. Codex Bridge (optional admin feature)

Mirror of the Claude Code bridge, but for driving a remote OpenAI Codex CLI session. Same semantics as the Claude Code variables above.

Leave all `CODEX_*` variables blank to disable.

| Variable | Default | Notes |
|---|---|---|
| `CODEX_HOST` | — | Remote Codex agent hostname |
| `CODEX_PORT` | `7701` | Agent port |
| `CODEX_SECRET` | — | Pre-shared auth secret |
| `CODEX_CA_PATH` | — | TLS CA path (relative to `/app`) |
| `CODEX_SERVERNAME` | `codex-agent` | SNI hostname |

---

## 8. Development & Bootstrap

### `SEED_DEMO_USER`

On first boot, automatically create an admin account using `DEMO_USERNAME` / `DEMO_PASSWORD`. This is what makes the "clone → `docker compose up` → log in" experience work out of the box.

- **Default:** `0`
- **Shipped in `.env.example` as:** `1` (for frictionless first run)
- **⚠️ Security:** Turn this off (or change `DEMO_PASSWORD`) **before exposing your instance to the internet**. The default credentials are public knowledge — anyone who finds your instance can log in as admin.

### `DEMO_USERNAME`

Username of the seeded demo admin account.

- **Default:** `demo`

### `DEMO_PASSWORD`

Password of the seeded demo admin account.

- **Default:** `demo-pass`
- **Security:** Change this before the first boot, or immediately after via **Settings → Change Password**, before allowing any external access.

### `MOCK_PROVIDER`

When `1`, replaces real LLM API calls with a deterministic in-memory mock. The mock returns canned responses for every provider without contacting the network. Useful for:

- Running the test suite offline
- UI development without burning tokens
- Reproducing bugs without provider variability

- **Default:** `0`
- **Values:** `0` | `1`

### `EXPOSE_AUTH_CODES`

When `1`, email verification codes, forgot-password codes, and MFA challenge codes are included in the API response body **in addition to** being emailed. This is a **development convenience only** — it lets you test those flows without needing SendGrid configured.

- **Default:** `0`
- **⚠️ Production guard:** The app will **refuse to start** if `EXPOSE_AUTH_CODES=1` and `NODE_ENV=production`. This prevents accidental exposure in production deployments.
- **⚠️ Security:** **Never enable outside of local development.** Leaks secrets over the wire in plaintext.

---

## Related Reading

- [`README.md`](README.md) — high-level install, architecture, feature tour
- [`.env.example`](.env.example) — copy-paste template
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow for contributors
