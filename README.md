# TracyHill RP

A self-hosted, multi-user LLM chat client supporting **Anthropic**, **OpenAI**, **xAI**, **DeepSeek**, **z.ai**, **Google**, and **custom OpenAI-compatible endpoints** — built for long-form collaborative fiction and roleplaying workflows. All API calls are proxied server-side so keys never reach the browser.

## Features

### Multi-Provider Chat
- **Anthropic** — Claude Opus 4.6, Sonnet 4.6, Sonnet 4, Haiku 4.5
- **OpenAI** — GPT-5.4 (1.05M ctx), GPT-5, GPT-5 Mini/Nano, o4-mini, o3, GPT-4.1 family (1.05M ctx)
- **xAI** — Grok 4, Grok 4 Fast/4.1 Fast (reasoning & non-reasoning), Grok 4.20 beta, Grok 3/Mini
- **DeepSeek** — DeepSeek V3 (128K ctx), DeepSeek R1 (128K ctx, always-on reasoning)
- **z.ai** — GLM-5, GLM-4.7, GLM-4.7 FlashX, GLM-4.6, GLM-4.5
- **Google** — Gemini 3.1 Pro, Gemini 3 Flash, Gemini 3.1 Flash-Lite, Gemini 2.5 Pro/Flash
- **Custom Endpoints** — add any OpenAI-compatible API (OpenRouter, LM Studio, Ollama, Together AI, Groq, vLLM, etc.)
  - Multiple named endpoints with independent API keys and auth settings
  - Per-endpoint model lists with configurable context and output limits
  - Supports HTTP (local servers) and HTTPS, Bearer / api-key / no-auth
  - Chat Completions and Responses API formats
  - Full disconnect recovery same as built-in providers
- Per-message model switching — change models mid-conversation
- Custom dropdown with provider submenus (custom endpoints appear as their own groups)
- All output limits set to each model's API maximum automatically

### Image Generation
- **GPT Image 1** and **DALL-E 3** (OpenAI)
- **Grok Image** and **Grok Image Pro** (xAI)
- **CogView-4** (z.ai)
- Drop-up model selector above the send button
- Images saved as flat files on disk (not in session state)
- Full-resolution rendering, click to open in new tab
- Admin purge tool to delete all generated images

### Thinking & Reasoning
- **Anthropic**: Off / Budget / Adaptive thinking modes with effort control (Low to Max)
- **OpenAI**: Reasoning effort (Low/Medium/High) via the Responses API with visible thinking summaries
- **z.ai**: Always-on thinking with `reasoning_content` in stream deltas
- **xAI**: Reasoning content displayed when available
- Collapsible thinking blocks in the UI

### Prompt Caching (Anthropic)
- Configurable TTL: Off / 5 min / 1 hr
- Off mode skips `cache_control` entirely to avoid write costs
- Live cache stats: READ tokens, WRITE tokens, HIT%

### Token Tracking & Cost
- Per-message: input, output, cache read/write, cost
- Per-session: totals for all metrics
- Cross-session: total cost across all sessions
- Context window usage bar with color coding
- Hover tooltips on all stats explaining what each number means
- Collapsible status bar (defaults open desktop, closed mobile)
- Billing portal drop-up with links to all 4 providers

### Session Management
- Create, rename, delete sessions
- **Recycle bin** — soft delete with restore, permanent delete, right-click to empty all. Auto-purge after 30 days.
- **Folders** — nested, collapsible, drag-and-drop sessions into folders, move modal alternative
- No session loaded on startup — user picks or creates
- Session export to clean markdown

### Message Actions
- Edit, resend, regenerate, cut-after, copy, delete
- Copy always available (even during streaming)
- Messages over 20 lines show action bar at top and bottom
- In-app confirmation dialogs (never browser `confirm()`)

### File Attachments
- Attach via paperclip button, drag-and-drop from file explorer, or **Ctrl+V paste** for screenshots
- Text files, images (PNG/JPG/GIF/WebP), PDFs
- PDF support: native on Anthropic and OpenAI; warning on xAI/z.ai
- MIME type inferred from file extension
- Templates inject as file attachment chips

### Streaming
- **Concurrent** — multiple sessions can stream simultaneously
- Per-session abort controllers, reader refs, and state
- Blinking dot indicator on streaming sessions in sidebar
- **Browser-disconnect recovery** — server accumulates responses independently; if browser closes mid-stream, the completed response is saved and merged on next load

### Multi-User & Auth
- Username + bcrypt password auth with rate limiting (3 failures → 30 min lockout)
- **MFA** — email-based (SendGrid), 6-digit codes with HMAC-SHA256, trust device for 30 days
- **Self-service registration** — open signup with email verification and Terms agreement
- **Forgot password** — email code verification with anti-enumeration protection
- **Account deletion** — 3-step self-service flow with MFA confirmation
- Admin panel: create/delete users, reset passwords, toggle roles, view any user's sessions
- **Storage stats**: disk total/used/free, image count & size, user data size, refresh on demand
- **Image purge**: admin can delete all generated images across all users
- Self-service password change
- Session-based auth with secure cookies behind reverse proxy

### Campaign System
- **Campaign Manager** — create and manage campaigns with system prompts, state seeds, and update templates
- **State Seed Update Pipeline** — multi-step LLM pipeline: generate updated seed → validate → surgical auto-fix → system prompt diff → approve/reject with full review UI
- **Campaign Wizard** — 4-step LLM-guided conversation that bootstraps new campaigns from scratch
- **Version history** — every pipeline approval archives the previous version with full rollback capability
- **Cold start injection** — Section A auto-extracted from state seed and injected as first message in new sessions
- **Multi-model** — pipeline and wizard support all flagship providers plus custom endpoints (beta)
- **Per-session architecture** — individual session files instead of monolithic state, granular API saves

### UI
- Dark theme
- Custom model picker with provider submenus
- Collapsible controls bar (cache, thinking, effort, max output, temperature, font size)
- Font size slider (10-24px) persisted globally
- Drag-resizable input area and edit textareas
- Mobile responsive with floating sidebar overlay
- Markdown rendering with code copy, dialogue highlighting, sanitized links

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/ArkAscendedAI/tracyhill-rp.git
cd tracyhill-rp
docker compose up -d --build

# 2. Create the first user (admin)
docker exec -it tracyhill-rp node set-password.js

# 3. Open in browser
# http://localhost:3000

# 4. Add API keys in Settings (at least one provider)
```

No `.env` file is needed for basic usage — the included `docker-compose.yml` works out of the box. Create a `.env` file later if you need email MFA (SendGrid) or agent proxy features (see `.env.example`).

### Development (without Docker)

```bash
npm install

# Terminal 1: Express backend (must be running first)
node server.js

# Terminal 2: Vite dev server (hot reload, proxies /api/* to port 3000)
npm run dev
```

> **Important:** Both `node server.js` AND `npm run dev` must be running for development. The Vite dev server only serves the frontend — it proxies all `/api/*` requests to the Express backend on port 3000.

## Docker Compose

The default `docker-compose.yml` is configured for quick local setup:

```yaml
services:
  tracyhill-rp:
    container_name: tracyhill-rp
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - NODE_ENV=production
      - ALLOWED_IPS=*
```

### Production Hardening

For production behind a reverse proxy, update `docker-compose.yml`:

```yaml
    environment:
      - NODE_ENV=production
      - TRUST_PROXY=true
      # Replace with your reverse proxy's IP(s)
      - ALLOWED_IPS=127.0.0.1,::1,::ffff:127.0.0.1,YOUR_PROXY_IP
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `TRUST_PROXY` | `false` | Set to `true` when behind a reverse proxy (enables secure cookies) |
| `NODE_ENV` | — | Set to `production` for Docker deployments |
| `ALLOWED_IPS` | `*` | Comma-separated IPs allowed to connect. `*` allows all (good for local use). For production, restrict to your reverse proxy IP(s). |
| `SENDGRID_API_KEY` | — | SendGrid API key (required for email MFA and registration) |
| `EMAIL_FROM` | `noreply@example.com` | Sender email for verification codes |
| `EMAIL_FROM_NAME` | `TracyHill` | Sender display name |

## Reverse Proxy (Nginx Proxy Manager)

Point a proxy host at `http://tracyhill-rp:3000`. Settings:

- **Websockets Support**: Not required (uses SSE streaming)
- **Block Common Exploits**: Yes
- **SSL**: Yes (Let's Encrypt or your own cert)

Set `TRUST_PROXY=true` and add your proxy host's IP to `ALLOWED_IPS` in docker-compose.yml.

## Data Persistence

All data lives in `./data/` (Docker volume mount):

```
data/
  users.json              # User accounts (bcrypt hashes, email, MFA config)
  session.secret          # Auto-generated session signing key
  images/                 # Generated images (flat PNG/JPG files)
  users/{userId}/
    meta.json             # User preferences (active session, font size, folders)
    sessions_meta.json    # Lightweight sidebar index
    sessions/{id}.json    # Individual session files (messages, model, config)
    apikeys.json          # API keys + custom endpoints (per-user, mode 0600)
    campaigns.json        # Campaign definitions
    campaign_versions/    # Archived campaign versions (kept in perpetuity)
    pipelines/            # Active pipeline state files
    wizard_templates.json # Wizard example templates
    pending/              # Disconnect-recovery pending messages
```

**Back up the `data/` directory to preserve everything.**

## API Keys

Each user configures their own API keys in Settings. Supported providers:

| Provider | Key format | Get a key |
|----------|-----------|-----------|
| Anthropic | `sk-ant-...` | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | `sk-...` | [platform.openai.com](https://platform.openai.com) |
| xAI | `xai-...` | [console.x.ai](https://console.x.ai) |
| DeepSeek | `sk-...` | [platform.deepseek.com](https://platform.deepseek.com) |
| z.ai | z.ai API key | [z.ai/model-api](https://z.ai/model-api) |
| Google | `AIza...` | [aistudio.google.com](https://aistudio.google.com) |

Keys are stored server-side and never sent to the browser. Each provider's models only appear in the model picker when the corresponding key is configured.

### Custom Endpoints

In addition to the built-in providers, you can add any number of **OpenAI-compatible API endpoints** in Settings:

- **OpenRouter**, **Together AI**, **Groq**, **Fireworks** — cloud API routers
- **LM Studio**, **Ollama**, **vLLM**, **text-generation-inference** — local model servers
- **Azure OpenAI** — via `api-key` auth header

Each endpoint is independently configured with its own base URL, API key, auth format, and model list. Custom endpoint models appear as their own group in the model picker and can be used for chat, pipeline, and wizard operations (pipeline/wizard support is beta).

## User Management

```bash
# Create or reset users from the CLI
docker exec -it tracyhill-rp node set-password.js

# Or use the admin panel in the web UI (Settings > Users)
```

Admins can:
- Create and delete users
- Reset passwords and toggle roles (admin/user)
- View any user's sessions
- See storage stats (disk usage, image count)
- Purge all generated images

## Development

See [Quick Start](#quick-start) above for both Docker and local development setup.

## Architecture

```
Browser ←→ Nginx Proxy Manager ←→ Express (port 3000)
                                     ├── Auth (session cookies, bcrypt, MFA, rate limit)
                                     ├── IP allowlist (TCP peer check)
                                     ├── Accumulating streaming proxy (disconnect recovery)
                                     │   ├── /api/proxy/anthropic → Anthropic Messages API
                                     │   ├── /api/proxy/openai → OpenAI Chat Completions
                                     │   ├── /api/proxy/openai-responses → OpenAI Responses API
                                     │   ├── /api/proxy/xai → xAI Chat Completions
                                     │   ├── /api/proxy/deepseek → DeepSeek Chat Completions
                                     │   ├── /api/proxy/zai → z.ai Chat Completions
                                     │   ├── /api/proxy/google → Google Gemini API
                                     │   └── /api/proxy/custom → User-defined OpenAI-compatible endpoints
                                     ├── Image generation
                                     │   ├── /api/imagegen/openai → OpenAI Images API
                                     │   ├── /api/imagegen/xai → xAI Images API
                                     │   ├── /api/imagegen/zai → z.ai Images API
                                     │   └── /api/imagegen/google → Google Gemini Image API
                                     ├── Campaign pipeline (/api/pipeline/*)
                                     ├── Campaign wizard (/api/wizard/*)
                                     ├── Per-session REST API (/api/sessions/*)
                                     ├── /api/images/:id (serve generated images)
                                     ├── /api/keys (per-user API keys + custom endpoints)
                                     ├── /api/admin/* (user mgmt, storage, image purge)
                                     ├── Registration, MFA, legal pages
                                     └── Static files (built React app in dist/)
```

All API calls are proxied through the Express server — the browser never communicates directly with any AI provider. Streaming responses are accumulated server-side so they survive browser disconnects.

## Tech Stack

- **Frontend**: React 18, Vite, lucide-react (App.jsx + CampaignManager + PipelineView + WizardReview)
- **Backend**: Express, express-session, bcryptjs, Node.js `https`/`http`
- **Storage**: JSON files on disk, per-session file architecture, atomic writes (tmp + rename)
- **Container**: Docker (node:20-alpine), multi-stage build
- **Styling**: All CSS inline in App.jsx (dark theme)
- **Email**: SendGrid API (raw fetch, no SDK) for MFA and registration

## Security

- API keys stored server-side only (never sent to browser)
- bcrypt password hashing (cost 12)
- Rate limiting on login (3 failures → 30 min lockout)
- MFA with HMAC-SHA256 hashed codes, per-challenge secrets, timing-safe trust tokens
- IP allowlist on TCP peer (gates reverse proxy, not end users)
- Secure session cookies (`httpOnly`, `secure`, `sameSite`)
- CSRF protection via Origin header validation
- XSS-safe markdown rendering (sanitized link URLs)
- Atomic file writes prevent corruption on crash
- Auth middleware validates user existence on every request
- Upstream request timeouts (5min streaming, 2min image gen)
- Security headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- Anti-enumeration on forgot password (same response for existing/non-existing users)

## License

MIT License. See [LICENSE](LICENSE) for details.
