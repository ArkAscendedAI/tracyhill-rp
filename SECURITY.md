# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability — especially in the authentication, MFA, or API proxying systems — **please do not open a public issue.**

Instead, report it via [GitHub Security Advisories](https://github.com/ArkAscendedAI/tracyhill-rp/security/advisories/new).

### What Qualifies

- Authentication bypass or session hijacking
- MFA code brute-force or timing attacks
- API key exposure to the browser
- Path traversal in user data storage
- IP allowlist bypass
- CSRF or XSS vulnerabilities
- Rate limiting bypass
- Unauthorized access to other users' data
- Server-side request forgery (SSRF) via custom-endpoint configuration

### Out of Scope

Reports about narrative content — tone, language, themes, anything the model wrote in response to a user-authored system prompt — are not security vulnerabilities. TracyHill RP is a general-purpose collaborative-fiction tool whose content rating is defined per-campaign by the user via the wizard (anywhere from light-rated PG to adult literary fiction). The application itself does not filter, rate, or moderate content; that's a function of the user's authored prompts, the configured provider's usage policies, and any moderation you choose to layer on top. For content concerns, adjust your wizard template, restrict provider access, or pick a provider with stricter content policies.

Prompt-injection paths that let a user make the model produce output outside the system-prompt-defined scope (e.g., context-engine bypasses, scene-parser bypasses, lorebook activation escapes) **are in scope** — those are bugs in the application layer, not content complaints.

### Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix and disclosure:** coordinated with reporter

## Architecture

All API keys are stored **encrypted at rest** (AES-256-GCM with an HKDF-derived key) in the SQLite database and never sent to the browser. Authentication uses bcrypt (cost 12) with session cookies stored in a SQLite-backed session store (durable across restarts), explicit session regeneration + save on login (anti-fixation), and per-IP / per-username rate limiting on every auth endpoint. MFA codes are HMAC-SHA256 hashed with per-challenge random secrets and verified using timing-safe comparison. Trusted device tokens are stored as SHA-256 hashes. The `/api/auth/forgot-password` endpoint returns a constant-shape response regardless of whether the supplied username matches (no account enumeration). CSRF protection uses Origin header validation with an `X-Requested-With` custom header fallback. Security headers include Content-Security-Policy (`script-src 'self'` — no `unsafe-inline`, no `unsafe-eval`), HSTS, X-Frame-Options DENY, Referrer-Policy, and Permissions-Policy.

Custom OpenAI-compatible endpoints are **SSRF-gated**: `baseUrl` values must parse as a valid `http(s)://` URL with no userinfo, and the server resolves the hostname at save time and rejects entries that point at private / loopback / link-local / CGNAT / reserved IPv4 ranges or `::1` / `fc00::/7` / `fe80::/10` / multicast IPv6. Operators can opt-in to specific LAN hosts via `CUSTOM_ENDPOINT_ALLOW_HOSTS`. Upstream error response bodies from custom endpoints are stripped before bubbling to the client SSE event so the channel can't be used to read back internal-service responses, and all upstream error bodies are capped at 16 KB.

Admin actions cannot delete or demote the last admin (avoiding a lockout). Account deletion fully cascades all per-user data and evicts active HTTP sessions; the audit log is intentionally retained.

The Docker container runs as a non-root user (UID 1001). The application refuses to start if `EXPOSE_AUTH_CODES=1` in production mode. All user-controlled path inputs are validated with strict regex patterns.
