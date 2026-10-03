# Security Policy

## Supported Versions

Security fixes land on the default branch and ship in the next release. Only the latest release is supported; older
releases do not receive fixes. Before you report, check that the problem still exists on the latest release.

## Reporting a Vulnerability

Report a security problem by opening an issue on this repository, or by messaging the maintainer directly if you would
rather not post the details publicly. Include the release or commit you tested, how the server was deployed (Docker
Compose or not, which reverse proxy, the `TRUST_PROXY` and `ALLOWED_IPS` values), the steps to reproduce, and what an
attacker gains.

### What Qualifies

- Authentication bypass or session hijacking
- Two-factor bypass, or brute force and timing attacks on authenticator, recovery or emailed codes
- Claiming a new server without its first-run setup code, or creating an account from an invite link that is expired,
  used or withdrawn
- A user account gaining administrator rights or reaching an administrator-only route
- Unauthorized access to another account's data, including its Claude or ChatGPT sign-in on the subscription runner
- Stored secrets (provider keys, email credentials, authenticator secrets) reaching the browser or an account that
  should not see them
- Path traversal in user data storage
- IP allowlist bypass
- CSRF or XSS
- Rate limit bypass
- Server-side request forgery (SSRF) through custom endpoint settings

Prompt injection and crafted imports are in scope when they make the application break one of its own rules: for
example, text that makes the context engine pull another account's data into a prompt, or a request that changes a
setting the account is not allowed to change.

### Out of Scope

What a model writes is not a security vulnerability. That covers tone, language and themes, and anything a model
produced from the prompts, templates and lorebooks that users wrote. TracyHill RP does not moderate or filter what
users send or what models return. It ships content controls, which are story settings and are not a security boundary:

- **World stance** (how the story world's causality treats the player character, from 0 Indulgent to 4 Predatory) and
  **Depiction tier** (how explicitly consequences are written, from 0 None to 3 Unflinching) are set per session, and
  only administrators can change them. A session created in a campaign takes the values of that campaign's newest
  session. Any other new session starts with the values set in Admin: Server settings → New sessions, or, when none
  are set there, with the built-in defaults: stance 4 and tier 3, the highest of each.
- **Content honesty** adds instructions that keep a model from refusing material inside the scope those two settings
  allow. It is on by default, any user can switch it off for a session, and it applies only when the composer model is
  a Google model or Kimi K3.
- Requests to Google models set Google's adjustable safety filters to off.

Each provider's own usage policies still apply. For milder content, set lower values under New sessions (accounts that
are not administrators cannot change them), choose providers with stricter policies, or add your own moderation in
front of the app.

### Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix and disclosure:** coordinated with the reporter

## Security Model

This section describes the protections the code ships with and what the operator has to provide.
[ENVIRONMENT.md](ENVIRONMENT.md) describes the configuration variables.

### Deployment

- Docker Compose runs four services. `tracyhill-rp-init` runs once as root before the others start: it hands a
  root-owned `./data` directory to the app user, prepares the deployment secret (next section), and exits. The API
  (`tracyhill-rp`), the worker and the subscription runner run as UID 1001.
- Only the API publishes a port (`HOST_PORT`, default 3000). The worker and the runner publish none.
- The API serves plain HTTP. Put it behind an HTTPS reverse proxy and set `TRUST_PROXY` to describe that proxy (a hop
  count or a list of trusted addresses). With `TRUST_PROXY` set, the session cookie gets the `Secure` flag, responses
  carry HSTS, and the client address that the rate limits use comes from `X-Forwarded-For`. Leave it unset when
  clients reach the API directly: with it set, a client could choose the address the rate limits see.
- `ALLOWED_IPS` (a comma-separated list) refuses every request whose TCP peer is not on it. Entries are single
  addresses, since CIDR ranges are not supported. An IPv4-mapped IPv6 peer matches its IPv4 entry, and loopback is
  always allowed. Behind a reverse proxy the peer is the proxy, so list the proxy's address. Empty or `*` (the Compose
  default) allows every address.
- Every response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a
  `Permissions-Policy` that turns off camera, microphone and geolocation. `Strict-Transport-Security: max-age=31536000;
  includeSubDomains` is added only when `TRUST_PROXY` is set. No response names the server's framework (`X-Powered-By`
  is off).
- CSRF: every request other than GET, HEAD and OPTIONS must send an `Origin` whose host equals the request's `Host`. A
  request without an `Origin` must send an `X-Requested-With` header instead. Cookies are `SameSite=Lax` as well.

### The Deployment Secret

`SESSION_SECRET` signs the session cookies, is the key material for every encrypted value in the database, and is the
source of the subscription runner's secret.

- When `SESSION_SECRET` is unset, the init service generates 48 random bytes (96 hex characters) on first boot and
  writes them to `data/v2/session.secret` with mode 0600. It never replaces that file, and a damaged one stops the init
  service with an error. An operator's `SESSION_SECRET` always wins, and then nothing is written. Outside Docker, the
  API creates the same file on its first start and the worker only reads it.
- The runner has its own secret, derived from the session secret with HKDF-SHA256. With a generated session secret, the
  init service writes only the derived value to a small `secrets` volume that the runner mounts read-only, so the
  runner never holds the session secret. When an operator sets `SESSION_SECRET`, the shipped Compose file passes it to
  the runner, which derives the same value. Setting `RUNNER_SECRET` replaces the derived value (for a runner on another
  host).
- Changing or losing the secret signs every user out and makes every encrypted value unreadable until someone enters it
  again. Authenticator apps then have to be set up again; recovery codes keep working, and an administrator can reset
  two-factor.
- A backup of `./data` holds the database and `data/v2/session.secret` together, which is what lets a restored server
  read its stored keys. Protect those backups as you would the secret. The runner's sign-ins live in the
  `subscriptions` volume, outside `./data`.

### Stored Secrets

- Encrypted with AES-256-GCM, with a fresh random 12-byte IV for each value, under a key derived from `SESSION_SECRET`
  with HKDF-SHA256: each account's provider API keys and custom endpoint keys, authenticator secrets (active and
  pending), and the secrets in Admin: Server settings (the server-wide API keys, the SendGrid API key and the SMTP
  password).
- Stored only as hashes: passwords (bcrypt), and recovery codes, trusted-device tokens and invite tokens (SHA-256).
- Emailed codes and the first-run setup code never reach the database. The API holds emailed codes in memory as
  HMAC-SHA256 values, each with its own random key.
- Everything else is plain data in SQLite: chat messages and attachments, campaigns, lorebooks and settings. Provider
  keys set through environment variables stay in the environment and never reach the database.
- The API never returns a stored key. An account sees a masked preview of its own provider keys (the last four
  characters) and only whether a custom endpoint has a key; administrators see at most the last four characters of a
  server-wide secret. The app never holds Claude or ChatGPT sign-ins: the official binaries in the runner keep them
  (see Subscription Runner).

### First-Run Setup

A new deployment has no accounts. At boot the API prints a one-time setup code to its log: 12 characters from a
30-character alphabet, about 59 bits. Whoever enters it in the browser creates the first administrator and is signed
in. The code lives only in the API's memory and its log, changes at every restart, and stops working once any account
exists. The check for an empty server and the insert share one database transaction, so two forms sent at once cannot
both create an administrator. Wrong codes spend a per-address budget (see Rate Limits). Anyone who can read the API log
while setup is open can claim the server.

### Accounts

- Sign-up is off on a new server (Admin: Server settings → Accounts). When it is open, registration also needs working
  email: the account is created only after the emailed code is verified, and its address is stored as verified.
- Invite links let an administrator add a person while sign-up is off and without email. Each link carries 24 random
  bytes; the server stores a SHA-256 hash and shows the link once. A link expires after 1 to 30 days (7 by default) and
  works once, because spending it and creating the account happen in one transaction. It gives the role the
  administrator picked (user or administrator), can fix the username in advance, and can be withdrawn while unused.
  The person chooses their own password and accepts the terms when the server requires that.
- Administrators can also create accounts directly. An email address they enter is stored as verified.
- Usernames are matched without regard to case.
- Sign-in and password reset do not reveal whether an account exists. Registration reports a username or email address
  that is already taken, invite acceptance reports a taken username, and the email change form (after the password)
  reports an address in use, so those three do.

### Passwords

Passwords are hashed with bcrypt at cost 12. A new password needs at least 8 characters, at most 72 bytes of UTF-8
(bcrypt ignores anything after that), a lower-case letter, an upper-case letter and a digit. A sign-in with an unknown
username still runs a bcrypt comparison, so the response time does not reveal whether the account exists. Changing a
password signs out the account's other sessions, and a reset by email or by an administrator signs out all of them.
All three forget the account's trusted devices.

### Sessions

- Sessions live in SQLite on the server. The cookie (`trp.sid`) is signed with `SESSION_SECRET`, is `HttpOnly` and
  `SameSite=Lax`, and is `Secure` when `TRUST_PROXY` is set.
- Every way of signing in issues a new session id: password sign-in, two-factor verification, the authenticator setup
  that Required two-factor asks for, registration, an invite and first-run setup.
- A session ends at a daily sign-out hour in the server's time zone, both set in Admin: Server settings → Sessions.
  The hour is 3 AM by default. A new server takes the time zone of the browser that ran first-run setup (or `TZ`, else
  UTC, when the browser sends none). Each request moves the expiry to the next sign-out hour at least four hours away,
  so a session ends at the first sign-out hour that comes four or more hours after its last request. The store
  enforces the expiry on the server. There is no absolute lifetime: an open tab that keeps making requests stays
  signed in.
- When a session ends while the web app is open, the page stays loaded under a sign-in overlay so unsent text survives,
  and signing in as a different account replaces the page. On a shared computer, sign out explicitly: an expired
  session leaves the last page in the tab, dimmed, beneath the overlay.
- Signing out destroys the session on the server. The trusted-device cookie stays (see Two-Factor).

### Two-Factor

Admin: Server settings → Two-factor sets the policy (Off, Optional or Required) and the methods allowed. A new server
starts at Optional, with the authenticator method on and the email method off.

- **Authenticator app (TOTP):** RFC 6238 with HMAC-SHA1, six digits and 30-second steps; a code from the step before or
  after the current one is accepted too. The server stores the last step it accepted and refuses any code at or before
  it, so each code works once. The secret is 20 random bytes, stored encrypted. A new authenticator replaces the old
  one only after a code from it is confirmed. Setting one up, removing it and replacing recovery codes ask for the
  password again, and removing it also needs a current code or a recovery code.
- **Recovery codes:** ten codes of ten characters (about 49 bits each), shown once, stored as SHA-256 hashes and each
  usable once. Replacing them voids the old set.
- **Email codes:** six digits sent to the account's verified address, valid for 10 minutes and five attempts. An
  account can be sent at most six codes per 10 minutes.
- Every code is compared in constant time.
- **Required:** an account with no factor sets up an authenticator after its password, before it is signed in.
  Required needs the authenticator method on, and nobody can remove their authenticator while it applies.
- **Optional with the email method on:** when email stops working, an account whose only factor is email signs in with
  its password alone, and the server records an error system event. This keeps people from being locked out when mail
  breaks. Under Required, the same account is sent to authenticator setup instead.
- **Trusted devices:** after entering a code, a person can trust the browser for 30 days, counted from that moment. The
  browser gets a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`trp.trust`), which is `Secure` when
  the request arrived over HTTPS: directly, or through a proxy that `TRUST_PROXY` trusts and that reports HTTPS in
  `X-Forwarded-Proto`. A client's own `X-Forwarded-Proto` does not count. The server keeps only a SHA-256 hash,
  at most ten per account. A trusted device skips the code but still goes through the setup that Required asks for.
  People can revoke their devices one at a time or all at once, and a password change or reset, an email change and a
  two-factor reset forget them all.
- **Lost access:** an administrator can reset another account's two-factor (authenticator, recovery codes and trusted
  devices). With a shell on the server, an operator can run the recovery command in the API container:
  `docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name>`
  with `--reset-two-factor`, `--new-password` (a random password, printed once; every session of the account is signed
  out) or `--two-factor-off` (the whole server, then restart the app). Each run writes an audit row.

### Rate Limits

The counters live in the API's memory, so a restart clears them. The client address comes from the TCP connection, or
from `X-Forwarded-For` when `TRUST_PROXY` is set; an IPv4-mapped IPv6 address counts as its IPv4 form.

- **Sign-in:** five failures for one username (compared without case) or 30 failures from one address lock further
  attempts for 30 minutes after the last failure. A successful sign-in clears both counters.
- **Code flows:** each flow has its own budget per address: registration (including opening and accepting invite
  links), password reset, two-factor (verifying and resending codes, and the setup that Required asks for), email
  change, and first-run setup. After ten requests in one flow from one address, that flow is refused for that address
  until 15 minutes after the last one. First-run setup counts only wrong codes.
- **Inside a flow:** a code allows five attempts and expires after 10 minutes, and each account (for registration,
  each email address) is sent at most six codes per 10 minutes.
- **Second-factor codes per account:** ten wrong codes (authenticator, recovery or emailed) within 15 minutes, across
  all of an account's sign-in challenges and from any address, stop that account's codes from being accepted until 15
  minutes after the first of them, and record an event for administrators. A correct code resets the count. The check
  sits at the code step, which only a correct password reaches, so it reveals nothing about the password.

### Password Reset

Password reset needs working email. Its first step answers the same way whether or not the account exists or has an
address: the same message, a reset token and the mask `***@***`, with a short random delay standing in for the email
send when nothing is sent. Every later step treats real and stand-in requests alike. Real email delivery time varies,
so this is not a constant-time guarantee. A verified code allows setting the new password for five minutes.

### Account Deletion

- A person deletes their own account with a code sent to the account's email address, so self-service deletion needs
  working email and an address on the account. An administrator can delete any account except their own.
- The database part runs in one transaction and goes through the same code that deletes a campaign, once for each of
  the account's campaigns. It removes the account's campaigns, sessions, messages and attachments, lorebooks and their
  revisions, generated-image records, provider keys and custom endpoints, templates, background runs, system events,
  two-factor data and subscription connection records. Audit rows stay, and their actor no longer resolves to a name.
- Three steps run outside that transaction. Before it, the API asks the runner to sign the account out of Claude and
  ChatGPT, which deletes the account's credential directories; the request runs in the background, and each sign-out is
  tried three times. When the runner still cannot be reached, the API records an error event for administrators, and
  shortly after each start (and every six hours) it removes the credential directories of every account that no longer
  exists. After the transaction, the API deletes the account's generated image files and destroys its HTTP sessions.

### Administrators

Administrators are trusted with the whole server. Each administrator-only route reads the account's current role from
the database on every request. The administrator pages refuse to delete the administrator's own account or change
their own role, and nobody can delete or demote the last administrator. An administrator can:

- read and change Server settings, including the server-wide keys and sign-ins (each change is audited by the names of
  the fields it touched, never their values);
- create and delete accounts, change roles, reset passwords and two-factor, and create and withdraw invites;
- list any account's chat sessions and read their messages, with every listing and every session opened recorded in
  the audit log;
- read the audit log, see storage use and delete every generated image;
- change the administrator-only story settings (World stance, Depiction tier and five related world settings) and the
  values new sessions start with;
- use the coding panels.

### Server-Wide Keys and Sign-Ins

In Admin: Server settings → Shared keys, an administrator can enter provider API keys and connect a Claude or ChatGPT
sign-in for the whole server. Every account without a key or sign-in of its own then uses them. The page says so, warns
that a provider may suspend a subscription shared this way, and asks the administrator to accept that risk before
connecting one. Provider keys set through environment variables (`ANTHROPIC_API_KEY` and the others) serve every
account in the same way; they take precedence over keys entered on the page, which then show as locked. An account's
own key or sign-in always comes first. When sign-up is open, anyone who can reach the server can create an account and
spend on these keys.

### Subscription Runner

- The runner keeps each account's Claude and ChatGPT sign-in, and the server-wide one, in a directory of its own in
  the `subscriptions` named volume, created with mode 0700. The official Claude Code and Codex binaries write the
  tokens there; the database records only the connection state and the account identity the binaries report.
- The runner publishes no port. The API and the worker reach it on the Compose network, send its secret as a bearer
  token (compared in constant time) and name the account in a header, which the runner checks against a strict pattern
  before using it as a directory name.
- Composer turns run with tools, shell access, web search and MCP servers switched off, in an empty working directory,
  with an environment that carries none of the runner's own variables and points only at that account's home.
- All the directories belong to the one system user the runner runs as, so the runner's own checks are what keep
  accounts apart.
- Removing the volume (`docker compose down -v`) deletes every sign-in.

### Custom Endpoints

Each account can add OpenAI-compatible endpoints of its own. The protections against server-side request forgery:

- The URL must use `https` and carry no user name or password.
- When the endpoint is saved, the server resolves the host name and refuses it if any resolved address is private or
  reserved. That covers loopback, RFC 1918, link-local, CGNAT, multicast, documentation and benchmarking ranges and the
  other reserved IPv4 blocks; the IPv6 unique-local, link-local, multicast and documentation ranges; and IPv4 addresses
  carried inside IPv6 (IPv4-mapped in dotted or hex form, IPv4-compatible, NAT64 and 6to4), which are checked against
  the IPv4 list. Names such as `localhost` and `host.docker.internal` are refused outright.
- `CUSTOM_ENDPOINT_ALLOW_HOSTS` names hosts that skip the address check (for a model server on your own network).
  They still need `https`.
- The check runs when the endpoint is saved. Later requests do not pin the resolved address, so a host whose DNS
  changes afterwards is not checked again; it would also need a valid certificate for its name. Requests to a custom
  endpoint refuse redirects, and an error body from one is never passed back to the user.

### Coding Panels

The Claude Code, Kimi and Codex panels are administrator-only and greyed out until configured; nothing sets them up
automatically. Each panel talks to an agent service that runs outside this app. The API connects to it over HTTPS,
checks its certificate against the CA file in the panel's `*_CA_PATH` variable (or the system trust store when that is
unset) and the configured server name, and sends the panel's `*_SECRET` as a bearer token. An agent works on the
machine where its service runs: it can read files there, and in a full-access mode it can change them and run
commands. An administrator account therefore carries whatever access the agent service has there. The Codex service
in `tools/codex-agent-service` accepts only addresses in its own `ALLOWED_IPS` (loopback by default) that present its
secret; its default mode is read-only with network access off. Panel uploads are capped at 20 MB per file.

### Request Limits

JSON request bodies are capped at:

- 64 KB on `/api/auth` and `/api/setup`, which answer before sign-in;
- 75 MB on `/api/chat`, `/api/lorebook` and the SillyTavern import (`/api/wizard/import`), read only after the session
  is confirmed as signed in;
- 28 MB on coding-panel uploads, read only for a signed-in administrator;
- 1 MB everywhere else.

A chat message carries at most eight attachments, each holding up to 6,500,000 characters of encoded content (about
4.8 MB). The runner accepts bodies up to 100 MB (`MAX_BODY_BYTES`) from the API and the worker.

### Audit Log and Server Logs

- The audit log is a database table that administrators read in the app (the newest 200 entries at most). Among
  other things it records account security changes (password, email and two-factor changes, trusted-device
  revocations, invite acceptance, self-service deletion), administrator actions on accounts, invites, storage and
  images, Server settings changes (field names only), subscription sign-ins, provider key changes (which providers
  changed, never the keys), coding-panel actions, first-run setup and each run of the recovery command. An entry keeps
  the actor's id and role and the request id. It records no IP address and survives the deletion of the actor's
  account. Sign-in attempts are not audited.
- The API, the worker and the runner log to standard output, the API and the worker as JSON lines. Their logger
  removes fields named `password`, `passwordHash`, `apiKey`, `api_key`, `token`, `accessToken`, `refreshToken`,
  `secret` and `authorization` (at the top level and up to two levels below it) and the cookie and authorization
  headers of logged requests, and request bodies are stripped from logged errors. Each request gets a line with its
  method and path and a line with its status and duration; neither carries the query string or the body. A request id
  sent by the client (`X-Request-Id`) is kept only when it is a plain token of up to 128 letters, digits, dots,
  underscores, colons and hyphens; otherwise the server assigns one, so logs and audit entries never carry text a
  client made up.
- Treat the API log as sensitive: while setup is open it holds the setup code. The token of an invite link is replaced
  by `[token]` in every logged path.

### Data Safety

When a request to cut a transcript after a message would remove more than two messages, it must name the newest
message the browser holds and the number of messages the person confirmed; otherwise the server refuses it. A stale
tab therefore cannot delete messages it never loaded.

### Development Switches

Keep these off on any server that other people can reach:

- `NODE_ENV=test` turns off the CSRF check, and with `SESSION_SECRET` unset it uses a fixed secret published in the
  source. Compose sets `NODE_ENV=production`.
- `SEED_DEMO_USER=1` creates an administrator with a known password (`DEMO_USERNAME` and `DEMO_PASSWORD`, `demo` and
  `demo-pass` by default) when the database has no accounts, which also closes first-run setup. Turning the switch off
  later leaves that account in place.
- `EXPOSE_AUTH_CODES=1` returns verification codes in API responses. The API refuses to start with it when
  `NODE_ENV=production`.
- `MOCK_PROVIDER=1` replaces chat and image generation with mock output; embeddings, email and the coding panels still
  make real network calls.
