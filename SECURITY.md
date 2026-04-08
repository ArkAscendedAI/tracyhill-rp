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

### Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix and disclosure:** coordinated with reporter

## Architecture

All API keys are stored server-side and never sent to the browser. Authentication uses bcrypt with session cookies. MFA codes are HMAC-SHA256 hashed with per-challenge random secrets and verified using timing-safe comparison. All user-controlled path inputs are validated with strict regex patterns.
