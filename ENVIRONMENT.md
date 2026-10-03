# Environment and configuration reference

This file describes how a TracyHill RP deployment is configured: the environment variables each process reads, the
settings an administrator changes in the app, the commands an operator runs on the server, and the optional coding
panels. [`README.md`](README.md) covers installation.

**Contents**

- [How configuration works](#how-configuration-works)
- [1. Core runtime](#1-core-runtime): ports, paths, the session secret, proxies, logging
- [2. Chat providers](#2-chat-providers): server-wide API keys
- [3. Local embeddings](#3-local-embeddings): a self-hosted embeddings server
- [4. Subscription runner](#4-subscription-runner): Claude and ChatGPT subscription sign-ins
- [5. Email](#5-email)
- [6. Two-factor sign-in](#6-two-factor-sign-in)
- [7. Coding panels](#7-coding-panels): the optional Claude Code, Kimi (K3) and Codex workspaces
- [8. First-run setup and development](#8-first-run-setup-and-development)

---

## How configuration works

### Nothing is required

On a fresh clone, `docker compose up -d` starts a working server without a `.env` file. Every variable has a working
default, and the first start creates the deployment's own random session secret (see
[`SESSION_SECRET`](#session_secret)). The shipped `docker-compose.yml` marks `.env` as optional (`required: false`,
which needs Docker Compose 2.24 or later).

To change a setting, copy `.env.example` to `.env`, uncomment and edit the lines you need, and run
`docker compose up -d` again; Compose recreates the containers whose configuration changed. Every setting in
`.env.example` is commented out and shows its default, so a copied file changes nothing until you edit it.

### How a value reaches a container

The shipped Compose file runs four services:

| Service | What it runs | Loads `.env` |
|---|---|---|
| `tracyhill-rp-init` | one-shot preparation before the others start ([details](#the-init-service)) | yes |
| `tracyhill-rp` | the API, which also serves the web app | yes |
| `tracyhill-rp-worker` | the background job worker | yes |
| `tracyhill-rp-runner` | the [subscription runner](#4-subscription-runner) | no |

Each variable below says how the shipped Compose file treats it, in one of these terms:

- **Listed:** the service's `environment:` block names the variable as `${NAME:-default}`. A value from `.env`, or
  from the shell that runs `docker compose`, reaches the container (the shell's value wins); a blank or missing value
  gets the default shown.
- **`.env` only:** the service's `environment:` block does not name it, but the API, worker and init services load the
  whole `.env` file (`env_file`), so a line in `.env` reaches them unchanged (a blank line arrives blank). A variable
  exported only in the shell does not reach them.
- **Compose only:** Compose itself reads the value, from `.env` or the shell, to build the configuration.
- **Not passed:** the runner loads no `.env`, so a variable its `environment:` block does not list can be set only with
  an override file.

### Override file

Compose reads `docker-compose.override.yml` from the same folder, when it exists, and merges it into
`docker-compose.yml`. Use one for anything the base file does not cover: mounting a CA file for a coding panel
([§ 7](#making-a-ca-file-readable-inside-the-container)), adding an embeddings server
([§ 3](#running-an-embeddings-server-with-compose)), or setting a runner-only variable:

```yaml
services:
  tracyhill-rp-runner:
    environment:
      RUNNER_CODEX_IDLE_MS: "900000"
```

An override's `environment:` and `volumes:` entries are added to the base file's; an entry with the same variable name
or mount target replaces the base one.

### Admin: Server settings

Administrators change most of the server's behaviour in the app, under **Admin: Server settings**. Changes apply at
once, without a restart.

| Page | What it holds |
|---|---|
| Accounts | sign-up Off or Open (Open needs working email), whether sign-up asks people to accept the terms, and the terms and privacy texts |
| Two-factor | the two-step sign-in policy and its methods ([§ 6](#6-two-factor-sign-in)) |
| Email | SendGrid or SMTP, the sender, and a test email ([§ 5](#5-email)) |
| Shared keys | server-wide provider API keys ([§ 2](#2-chat-providers)) and server-wide Claude and ChatGPT sign-ins ([§ 4](#4-subscription-runner)) |
| Sessions | the hour and time zone of the daily sign-out |
| New sessions | the starting world stance and depiction tier of new sessions that inherit no campaign settings |
| Server | read-only: `TRUST_PROXY`, `ALLOWED_IPS`, and which coding panels are set up |

The values live in the database. Secrets entered there (the SendGrid key, the SMTP password, the shared keys) are
encrypted with a key derived from `SESSION_SECRET`; after saving, the page shows only that one is set and its last four
characters.

**A value set in the environment wins.** Where an environment variable sets something the page also offers, the page
shows the field locked ("Set in the server's configuration (.env)") and refuses changes to it:

| Variable | Locks |
|---|---|
| `SENDGRID_API_KEY` | the email provider, the SendGrid key and every SMTP field |
| `EMAIL_FROM` | the sender address |
| `EMAIL_FROM_NAME` | the sender name |
| a provider key such as `OPENAI_API_KEY` | that provider's shared key |

### What stays in the environment

Ports, `TRUST_PROXY`, `ALLOWED_IPS`, HTTPS and the coding panels are configured only in the environment: the app needs
them before it starts, and a wrong value saved from a web page could lock everyone out. HTTPS is not an app setting at
all. The app serves plain HTTP and expects a reverse proxy in front of it to provide HTTPS (see
[`TRUST_PROXY`](#trust_proxy)).

### Servers that predate Server settings

When the API starts on a database that already has accounts but no record of first-run setup (a database from an
earlier release), it records settings that keep the server's earlier behaviour: sign-up Open, two-factor Optional with
both the authenticator and email-code methods on, the daily sign-out at 3 AM America/New_York, and a starting world
stance of 1 and depiction tier of 0 for new sessions. A server set up through [first-run setup](#first-run-setup)
starts with sign-up Off, two-factor Optional with the authenticator method only, the daily sign-out at 3 AM in the time
zone of the browser that ran setup, and the built-in starting stance 4 and tier 3. Everything can be changed on the
page afterwards.

### Empty values

A blank value (`NAME=` in `.env`) counts as unset for most variables: everything the API reads through its
configuration loader, `LOG_LEVEL`, `DEFAULT_MODEL_ID`, `CODEX_TURN_LIMIT`, `CODEX_DESCENDANT_TURN_LIMIT`, the worker's
`SESSION_SECRET` and `PIPELINE_POLL_MS` (which logs a warning), and the variables of the init service and the runner.
The exceptions:

- `INLINE_WORKERS`, `CONTEXT_SCORING_WORKER` and `CHAT_PRECOMPOSER_OVERLAP` are on unless the value is exactly `0`, so
  a blank value turns them on.
- `SEED_DEMO_USER`, `MOCK_PROVIDER` and `EXPOSE_AUTH_CODES` are on only when the value is exactly `1`.
- The worker uses a blank `DB_FILE` as it is; under Compose a blank `DB_FILE` gets the listed default. A blank
  `WORKER_HEARTBEAT_FILE` means the default, for the worker and for its healthcheck alike.

### The init service

Compose runs `tracyhill-rp-init` to completion before it starts the API, the worker and the runner. It runs as root
and then exits. It:

1. hands `./data` to the app's user (UID 1001) when root owns it (Docker creates a missing bind-mount folder owned by
   root), leaves a folder owned by anyone else as it is, and creates `data/v2`;
2. creates the session secret in `data/v2/session.secret` on the first start when `SESSION_SECRET` is unset, and keeps
   it on every later start;
3. writes the runner's secret, derived from the session secret, to the small `secrets` volume, unless `RUNNER_SECRET`
   is set.

If it fails, nothing else starts, and `docker compose logs tracyhill-rp-init` says why. It stops with an error rather
than replace a `session.secret` file that holds fewer than 32 characters. Besides `SESSION_SECRET` and `RUNNER_SECRET`
it reads `RUNNER_SECRET_FILE` (set by the Compose file) and `INIT_DATA_DIR` (default `/app/data`; leave it unset).

### Running without Docker

The images use Node.js 20. Outside Docker:

- The npm scripts do not read `.env`: export the variables in each shell.
- Several defaults differ from the Compose file. `PORT` is 4010; inline workers are on unless `INLINE_WORKERS=0`;
  `ALLOWED_IPS` is empty, which allows every peer; `DB_FILE`, `IMAGE_DIR`, `WEB_DIST_DIR` and the session secret file
  (`data/v2/session.secret`) resolve against the process's working directory.
- `npm run start:api` and `npm run start:worker` run from the repository root, so the two share `./data`. The
  `dev:api` and `dev:worker` scripts run inside `apps/api` and `apps/worker`. With them, set the same absolute
  `DB_FILE` and `IMAGE_DIR` in both shells, and the same `SESSION_SECRET`: otherwise each process looks for its own
  `data/v2/session.secret`, and the worker refuses to start when it finds none.
- Run jobs in one place only: the API alone with inline workers, or the API with `INLINE_WORKERS=0` plus the worker.
- The subscription runner needs its own dependencies (`npm --prefix apps/runner ci`), then `npm run start:runner`.
  Give it a writable `RUNNER_DATA_DIR` (the default is `/srv/subscriptions`) and the same `SESSION_SECRET` (or
  `RUNNER_SECRET`) as the API and the worker, and point those two at it with `RUNNER_URL=http://127.0.0.1:7710` (the
  default names the Compose service).

---

## 1. Core runtime

### `SESSION_SECRET`

The deployment's root secret. It signs the session cookies, and the app derives two keys from it:

- an AES-256-GCM key (through HKDF-SHA256) that encrypts, in the database, every account's provider API keys and
  custom-endpoint keys, the authenticator-app secrets, and the secrets saved in Admin: Server settings (the SendGrid
  key, the SMTP password and the shared provider keys);
- the [runner's secret](#runner_secret), unless `RUNNER_SECRET` is set.

Passwords, recovery codes, invite links and trusted devices are stored as hashes and do not depend on it.

- **Default:** none to set. With the variable unset, the first start generates 48 random bytes from the system's
  secure random generator (96 hexadecimal characters) and stores them in `data/v2/session.secret` with mode 0600, which
  is `./data/v2/session.secret` on the host under Compose, wherever `DB_FILE` points. Under Docker the init service
  writes it before anything else starts; a bare-Node API writes it on its first start. A stored secret is never
  replaced: a file that exists but holds no usable secret (under 32 characters) stops the init service and the API
  until you fix or remove it, or set `SESSION_SECRET`.
- **Precedence:** a value in the variable always wins, and then nothing is stored. Otherwise every process uses the
  stored file. Under `NODE_ENV=test` the API uses a fixed development value instead.
- **Read by:** the init service, the API and the worker. The runner reads it only when you set it (to derive its own
  secret); otherwise it reads the derived secret the init service wrote.
- **Compose:** listed (blank when unset) for all four services, so a value in `.env` or exported in the shell reaches
  every one of them.
- **When to set it:** only to carry over an existing deployment's secret. Use a long random value, for example the
  output of `openssl rand -hex 48`.
- **Backups:** keep the secret with the database. A database restored without its `session.secret` file, or started
  with a different `SESSION_SECRET`, cannot decrypt the values listed above. Copying the whole `./data` folder keeps
  the two together.
- **Changing it** signs everyone out and makes every value it encrypts unreadable: each account enters its provider
  and custom-endpoint keys again (the Providers dialog flags them), an administrator enters the Server settings secrets
  again, and people with an authenticator app sign in with a recovery code (or have an administrator reset their
  two-factor) and set the app up again. Subscription sign-ins are not affected. Change it with the stack stopped
  (`docker compose down`, edit `.env`, `docker compose up -d`), so that every service starts with the new value and
  the init service writes the runner's new secret.

### `PORT`

The port the API listens on inside its container.

- **Default:** `3000` under Compose; `4010` when the API runs outside Docker
- **Read by:** the API
- **Compose:** listed for the API (`3000`). Compose also uses it as the container side of the published port and in
  the API's healthcheck.

### `HOST_PORT`

The port published on the Docker host. The app is reachable at `http://<host>:<HOST_PORT>`.

- **Default:** `3000`
- **Compose:** Compose only
- **Example:** `HOST_PORT=8080`. The value may include an address: `HOST_PORT=127.0.0.1:3000` publishes the port on
  the host's loopback interface only, for a reverse proxy on the same machine.

### `DB_FILE`

Path of the SQLite database.

- **Default:** `/app/data/v2/tracyhill-rp-v2.sqlite` under Compose; `data/v2/tracyhill-rp-v2.sqlite` under the working
  directory outside Docker
- **Read by:** the API, the worker, and the two server commands
  ([email adoption](#moving-email-from-env-into-server-settings) and [recovery](#lost-phone-or-locked-out)), which take
  it from the app container's environment
- **Compose:** listed for the API and the worker
- **Notes:** the API and the worker create the folder when it is missing. Under Compose keep the file inside
  `/app/data`, the bind-mounted `./data`: anywhere else the database does not survive a container rebuild, and the
  app's user may not be allowed to write there.

### `IMAGE_DIR`

Folder for generated images.

- **Default:** `/app/data/v2/images` under Compose; `data/v2/images` under the working directory outside Docker
- **Read by:** the API
- **Compose:** listed for the API and the worker (the worker does not use it)
- **Notes:** a flat folder of `<imageId>.png` (PNG images) and `<imageId>.bin` (any other image type), created when
  missing. Files attached to messages are stored in the database.

### `WEB_DIST_DIR`

The built web app that the API serves.

- **Default:** `/app/apps/web/dist` under Compose, where the image build puts it; `apps/web/dist` under the working
  directory outside Docker
- **Read by:** the API
- **Compose:** listed for the API

### `INLINE_WORKERS`

Whether the API process also runs the background jobs (the campaign pipeline and the campaign wizard). With `1` the API
starts queued jobs itself; with `0` the dedicated worker picks them up by polling the database.

- **Default:** `0` under Compose; on (anything but `0`) outside Docker
- **Read by:** the API
- **Compose:** listed for the API (`0`)
- **Leave it at `0` under the shipped Compose file.** The worker container runs whatever this says, and two processes
  that both run jobs requeue each other's running jobs whenever either one starts. Use inline workers only where no
  dedicated worker runs, such as a single API started with Node.

### `CONTEXT_SCORING_WORKER`

Whether the per-turn retrieval scoring of context assembly (keyword activation with recursion, the remap of compressed
trigger keywords, the scene-present character match) runs on a worker thread of the API process. The scoring is pure
CPU work; on a large campaign it would otherwise hold up the API's other requests while a turn assembles.

- **Default:** on (anything but `0`, blank included)
- **Values:** `1` (a worker thread) or `0` (the API's main thread, with the same results)
- **Read by:** the API
- **Compose:** `.env` only
- **Failure behaviour:** if the thread cannot start, crashes, or takes longer than 30 seconds on a turn, that turn is
  scored on the main thread with the same results, a `context_assembly` warning is recorded in the system events, and
  the next turn starts a new thread. At start the API logs `retrieval scoring worker online`, or that the worker is
  disabled.

### `CHAT_PRECOMPOSER_OVERLAP`

Whether a campaign turn starts its two world-model helper calls, the antagonist-intent pass and the contested-action
classifier, alongside context assembly instead of after it. Neither call reads the assembled context, so running them
together shortens the wait before the reply starts. The state they write (nemesis promotion, threat-fuse burns, the
player's contest roll) is still applied in the original order.

- **Default:** on (anything but `0`, blank included)
- **Values:** `1` (overlap) or `0` (the serial order: assembly, then the intent pass, then the classifier)
- **Read by:** the API, so a change takes effect when the API container is recreated
- **Compose:** `.env` only
- **Notes:** every campaign turn records a "Pre-composer phases" note with each phase's duration in the turn's context
  information, which makes the two settings easy to compare. With overlap on, a turn's helper model calls run at the
  same time, which matters on a rate-limited provider account.

### `PIPELINE_POLL_MS`

How often the dedicated worker checks the database for queued jobs, in milliseconds.

- **Default:** `1000`
- **Read by:** the worker
- **Compose:** listed for the worker (`1000`)
- **Notes:** a blank or non-integer value, or one below 50, falls back to 1000 and the worker logs why (also in its
  start-up system event). The worker updates its heartbeat about every 15 seconds, or once per poll when the interval
  is longer; keep the interval well under 90 seconds, past which the container's healthcheck reports the worker
  unhealthy.

### `WORKER_HEARTBEAT_FILE`

The file the dedicated worker updates as its liveness signal, about every 15 seconds (see
[`PIPELINE_POLL_MS`](#pipeline_poll_ms)). The worker also updates a database row on the same schedule, which the API's
health endpoint and liveness checks read.

- **Default:** `/tmp/worker-heartbeat`
- **Read by:** the worker
- **Compose:** `.env` only
- **Healthcheck:** the worker container's healthcheck reads the same variable from the container's environment (a
  blank value means the default) and reports the container unhealthy when the file is more than 90 seconds old.

### `TRUST_PROXY`

Tells the API that reverse proxies sit in front of it, and how many.

- **Default:** off
- **Values** (any letter case): `1`, `true`, `yes` or `on` trust one proxy; `0`, `false`, `no`, `off` or blank turn it
  off; a whole number of 2 or more trusts that many proxies in a row; anything else is handed to Express as a list of
  trusted addresses, subnets or presets (for example `loopback, 192.0.2.10`), which Express checks at start, so an
  invalid entry stops the API.
- **Read by:** the API
- **Compose:** listed for the API (`false`)
- **Effect:** with trust on, Express takes the client's address from `X-Forwarded-For` and the protocol from
  `X-Forwarded-Proto`, so the per-address limits on sign-in, setup and verification codes count each client
  separately. Turning it on also marks the session cookie `Secure`, lets the trusted-device cookie be `Secure` on
  requests the proxy reports as HTTPS, and adds a `Strict-Transport-Security` header (one year, subdomains included).
- **Set it** when a reverse proxy that provides HTTPS connects to the app. With trust on, the app sets the session
  cookie only on requests the proxy reports as HTTPS (`X-Forwarded-Proto: https`), so without such a proxy nobody can
  stay signed in. Leave it off when browsers connect to the app directly.
- **Count only the proxies between the client and the container.** Use `1` when the proxy connects to the container
  directly, and a larger number only when several proxies really are chained. Too low a count makes the nearest
  proxy's address everyone's address, so all clients share one rate-limit budget; too high a count lets a client pick
  its own address with a forged `X-Forwarded-For`.
- Shown read-only in Admin: Server settings, Server page.

### `ALLOWED_IPS`

Restricts which hosts may open connections to the API, normally your reverse proxy. It checks the TCP peer of each
connection and never `X-Forwarded-For`, so it does not filter end users.

- **Default:** `*` under Compose; empty outside Docker. Both allow every peer.
- **Values:** `*`, blank, or a comma-separated list of exact IP addresses. Ranges and CIDR notation are not supported.
- **Read by:** the API
- **Compose:** listed for the API (`*`)
- **Example:** `ALLOWED_IPS=192.0.2.10` (the reverse proxy's address)
- **Notes:** an IPv4-mapped IPv6 peer (`::ffff:192.0.2.10`) matches its plain IPv4 entry. `127.0.0.1` and `::1` always
  pass; inside a container they are the container itself, which the healthcheck uses. Under Docker, list the address
  the container sees: connections from other machines normally keep their own address, while connections made to the
  published port from the Docker host itself normally arrive from the Compose network's gateway. A refused connection
  gets `403 {"error":"forbidden"}`. Shown read-only in Admin: Server settings, Server page.

### `CUSTOM_ENDPOINT_ALLOW_HOSTS`

Host names whose custom endpoints may point at private addresses. Accounts add OpenAI-compatible endpoints under
**Options → Providers → Custom Endpoints**, and by default each endpoint's base URL must resolve to a public address
(loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges are refused). A host listed here
skips that check, which allows a server on your own network such as LM Studio or Ollama.

- **Default:** empty
- **Values:** comma-separated host names, matched without regard to letter case
- **Read by:** the API
- **Compose:** `.env` only
- **Example:** `CUSTOM_ENDPOINT_ALLOW_HOSTS=lmstudio.local,ollama.lan`
- **Security:** every custom endpoint must still use `https://`, listed or not, so a server on your network needs a
  certificate the API container trusts. List only hosts you control: a listed host lets accounts make the API send
  requests into your network.

### `LOG_LEVEL`

Verbosity of the structured JSON logs.

- **Default:** `info` (blank means `info`)
- **Values:** `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. An unknown value stops the process at
  start.
- **Read by:** the API and the worker
- **Compose:** listed for the API, the worker and the runner (`info`); the runner does not use it

### `DOCKER_LOG_MAX_SIZE` / `DOCKER_LOG_MAX_FILE`

Rotation of the container logs (Docker's `json-file` driver), for every service.

- **Defaults:** `10m` and `5` (up to five files of 10 MB per container)
- **Compose:** Compose only
- **Example:** `DOCKER_LOG_MAX_SIZE=50m`, `DOCKER_LOG_MAX_FILE=3`

### `DEFAULT_MODEL_ID`

A deployment-wide default chat model. When it names a chat model in the app's catalog, it replaces the built-in
default wherever a default applies: new blank sessions, the campaign wizard's model picker, and the model every
automated worker or helper falls back to. Explicit session, wizard and job choices still win.

It applies to the accounts that can use its model. For an account that cannot (no key or sign-in for that model's
provider), a new session starts as described below for a server without the variable, every helper and worker dial is
written into the session so none of them falls back to the variable's model, and the wizard and the lorebook import
preselect a model the account has. While an account can use no provider at all, the variable's model stands.

Without it, a session that has no earlier session of its campaign to inherit from (a new campaign's first session, the
first session of the wizard or a lorebook import, or a session outside any campaign) starts on Claude Opus 4.6 when the
account can use it: `claude-opus-4-6` with an Anthropic key, else `claude-opus-4-6-bridge` with a Claude sign-in. When it
cannot, the session starts on the first catalog model of the first provider the account can reach, in this order:
Anthropic, Claude sign-in, OpenAI, ChatGPT sign-in, Google, xAI, DeepSeek, Moonshot, Z.ai, Xiaomi, Fireworks, GMICloud,
then the account's custom endpoints. "Can reach" counts the account's own key or sign-in, a server-wide one, and the
environment's keys. The helper and worker dials keep their shipped Claude defaults when the account has a Claude
sign-in; with an Anthropic key and no sign-in they move to the same models through the API, and otherwise to the
session's own model. The choices are written into that first session, and later sessions of the campaign inherit them.

Embedding models are not affected by this variable. A first session whose account cannot reach Google's embedding model
embeds with OpenAI's `text-embedding-3-large`, or with the local server when `LOCAL_EMBEDDING_URL` is set, and keeps the
Google default otherwise (keyword retrieval only until one is available). Engine settings belong to each session, and a
new campaign session takes the settings of the campaign's newest session.

- **Default:** unset (each surface keeps its built-in default)
- **Example:** `DEFAULT_MODEL_ID=claude-sonnet-4-6`
- **Read by:** the API and the worker
- **Compose:** `.env` only
- **An invalid id** is ignored, the built-in defaults stay in effect, and the API reports it as a catalog error at
  start. With `NODE_ENV=production` (the Compose setting) it logs the error, records it in the system events and keeps
  running; with any other `NODE_ENV` the API refuses to start.

### `TZ`

The time zone a new server's daily sign-out falls back to.

- **Default:** unset, which means UTC for this purpose
- **Read by:** the API
- **Compose:** `.env` only
- **Notes:** first-run setup normally records the time zone of the browser that ran it; `TZ` applies when that browser
  reported no zone the server knows, and before setup has run. After setup the zone is a Server setting (Sessions
  page). `TZ` is also the standard variable for a process's local time zone.

---

## 2. Chat providers

Every provider key is optional. For each provider, an account uses its own key when it has one (**Options →
Providers**); otherwise it uses the server's key, which is the environment variable when that is set and otherwise the
shared key saved in **Admin: Server settings → Shared keys**. Setting the variable locks that provider's shared key on
the page. Every account without a key of its own can use a server key, and the provider charges that use to the key's
owner. Keys are read whenever a model runtime is built, so a shared key saved on the page applies from the next turn;
a change to the environment needs `docker compose up -d`.

An account's own keys are encrypted in the database (see [`SESSION_SECRET`](#session_secret)), and no status response
returns a stored key, only a short preview.

| Variable | Provider and what it unlocks | Compose | Where to get a key |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic: Claude models | listed | [console.anthropic.com](https://console.anthropic.com/) |
| `DEEPSEEK_API_KEY` | DeepSeek models | listed | [platform.deepseek.com](https://platform.deepseek.com/) |
| `FIREWORKS_API_KEY` | Fireworks AI: Kimi K3 and K3 Fast | `.env` only | [fireworks.ai](https://fireworks.ai/) |
| `GMICLOUD_API_KEY` | GMICloud: Xiaomi MiMo models | `.env` only | [gmicloud.ai](https://www.gmicloud.ai/) |
| `GOOGLE_API_KEY` | Google: Gemini chat and image models, Google embeddings | listed | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `MOONSHOT_API_KEY` | Moonshot AI: Kimi K3 and K2.6 | `.env` only | [platform.moonshot.ai](https://platform.moonshot.ai/) |
| `OPENAI_API_KEY` | OpenAI: GPT models, GPT Image models, OpenAI embeddings | listed | [platform.openai.com](https://platform.openai.com/api-keys) |
| `XAI_API_KEY` | xAI: Grok chat models and Grok Imagine | listed | [console.x.ai](https://console.x.ai/) |
| `XIAOMI_API_KEY` | Xiaomi MiMo models | `.env` only | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) |
| `ZAI_API_KEY` | z.ai: GLM chat models and GLM Image | listed | [z.ai](https://z.ai/) |

All ten are read by the API and the worker; "listed" means listed for both.

**Embeddings.** Semantic and hybrid retrieval need an embedding provider. New sessions use hybrid retrieval with
Google's embedding model, so a session whose account has no Google key of its own, on a server without one, falls back
to keyword retrieval and records a warning in the system events. A session can switch to an OpenAI model or to a
[local model](#3-local-embeddings) in its Context Engine settings.

**Custom endpoints.** Any OpenAI-compatible service (OpenRouter, LM Studio, Ollama, Together AI, Groq, vLLM and
others) can be added per account under **Options → Providers → Custom Endpoints**, with no environment variable. Each
endpoint must use `https://`, and one on your own network also needs its host listed in
[`CUSTOM_ENDPOINT_ALLOW_HOSTS`](#custom_endpoint_allow_hosts).

---

## 3. Local embeddings

Semantic retrieval can compute its embeddings on an OpenAI-compatible embeddings server you run yourself (Hugging Face
Text Embeddings Inference, Ollama, LM Studio, vLLM and similar) instead of OpenAI or Google. No API key is needed, and
the lorebook text goes only to the server you configure. The `local:` embedding models stay unavailable until
`LOCAL_EMBEDDING_URL` is set; nothing changes for sessions that use other embedding models.

### `LOCAL_EMBEDDING_URL` / `LOCAL_EMBEDDING_KEY`

- **`LOCAL_EMBEDDING_URL`:** the server's base URL, ending in `/v1`. The app posts to `<URL>/embeddings` with
  `{"input": [...], "model": "<name>"}`, where the name is the model id after `local:`. Plain `http://` works, and the
  private-address check of custom endpoints does not apply to this server-level setting.
- **`LOCAL_EMBEDDING_KEY`:** optional; sent as `Authorization: Bearer <key>` for servers that require one.
- **Default:** unset (the local models are unavailable)
- **Read by:** the API and the worker, so lorebook updates made by background jobs use the same server
- **Compose:** `.env` only
- **Example:** `LOCAL_EMBEDDING_URL=http://embeddings.lan:11434/v1`

### Models

| Model id | Dimensions | Notes | Starting threshold |
|---|---|---|---|
| `local:nomic-embed-text-v1.5` | 768 | Runs well on a CPU. The app adds the `search_document:` and `search_query:` prefixes the model was trained with. | 0.35 |
| `local:bge-m3` | 1024 | Larger and heavier to run. No prefix. | 0.55 |

The server must answer to the model name after `local:` (`nomic-embed-text-v1.5` or `bge-m3`).

Cosine similarity runs on a different scale for each model family, so a good semantic threshold depends on the model.
The starting thresholds above are estimates recorded in the model catalog; the app does not show or apply them. Each
session's similarity threshold (default 0.25) is set in its Context Engine settings; check retrieval on a few known
turns before relying on a value.

### Using a local model

1. Set `LOCAL_EMBEDDING_URL` (and `LOCAL_EMBEDDING_KEY` if needed) in `.env` and run `docker compose up -d`.
2. Open a session's **Context Engine** settings, page **Context**, group **Retrieval**. Set **Retrieval mode** to
   Semantic or Hybrid and choose a Local model under **Embedding model**.
3. Switching the embedding model re-embeds the session's whole campaign (disabled entries included) in the background,
   skipping entries already embedded with the same text under that model. Start and result are recorded in the system
   events, and retrieval is keyword-only until it finishes. Vectors are stored per model, so switching back to an
   earlier model reuses the vectors that are still current.
4. The lorebook panel's **Rebuild Embeddings…** re-embeds the campaign's enabled entries on demand: only the stale and
   missing ones, or all of them.

A session set to a local model while `LOCAL_EMBEDDING_URL` is unset falls back to keyword retrieval and records a
warning. Each request to the local server may take up to 120 seconds, and indexing sends up to 32 entries per request.

### Running an embeddings server with Compose

Either example goes in `docker-compose.override.yml` next to `docker-compose.yml`. The service joins the app's Compose
network, where the API and the worker reach it by its service name; no port needs to be published on the host. Run
`docker compose up -d` afterwards.

**Hugging Face Text Embeddings Inference** (serves one model; downloads it on the first start):

```yaml
services:
  embeddings:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
    command: ["--model-id", "nomic-ai/nomic-embed-text-v1.5", "--pooling", "mean", "--served-model-name", "nomic-embed-text-v1.5"]
    volumes:
      - embeddings-data:/data
    restart: unless-stopped

volumes:
  embeddings-data:
```

With `LOCAL_EMBEDDING_URL=http://embeddings/v1` in `.env`. On an ARM host use the `cpu-arm64-1.9` tag.

**Ollama:**

```yaml
services:
  embeddings:
    image: ollama/ollama:latest
    volumes:
      - ollama-models:/root/.ollama
    restart: unless-stopped

volumes:
  ollama-models:
```

With `LOCAL_EMBEDDING_URL=http://embeddings:11434/v1` in `.env`. Ollama's library calls the nomic model
`nomic-embed-text`, so pull it and copy it to the name the app sends; `bge-m3` already has the right name:

```bash
docker compose exec embeddings ollama pull nomic-embed-text
docker compose exec embeddings ollama cp nomic-embed-text nomic-embed-text-v1.5
docker compose exec embeddings ollama pull bge-m3
```

---

## 4. Subscription runner

The `tracyhill-rp-runner` service serves the composer's subscription-backed models: the `-bridge` Claude models through
the Claude Code binary bundled with the Claude Agent SDK, and the `-codex-bridge` ChatGPT models through the Codex
app server. Both official binaries are installed when the runner image is built (versions pinned in
`apps/runner/package.json`).

Each account signs in to its own subscription under **Options → Providers → Subscriptions**. An administrator can also
connect a server-wide Claude or ChatGPT sign-in under **Admin: Server settings → Shared keys**, which every account
without its own sign-in then uses; the page warns that sharing a subscription may get that account banned. A
subscription model appears in an account's pickers once its own sign-in, or the server-wide one, is connected. The
runner keeps one credential home per account, written only by the official binaries, on the named volume
`subscriptions`; the app never sees a token. That volume is not part of `./data`: a backup of `./data` does not include
the sign-ins, and `docker compose down -v` deletes them.

The runner publishes no port. The API and the worker reach it over the Compose network with a shared secret, and
nothing needs to be set for the shipped deployment.

### `RUNNER_URL`

Base URL of the runner. The API and the worker call `/v1/messages`, `/v2/composer/messages`, `/accounts/...` and
`/healthz` under it.

- **Default:** `http://tracyhill-rp-runner:7710` (the Compose service name)
- **Read by:** the API and the worker
- **Compose:** listed for the API and the worker
- **Example:** `RUNNER_URL=http://runner.example.internal:7710` for a runner on another host
- **Notes:** 15 seconds after it starts, the API checks the runner's `/healthz` and records a warning in the system
  events when the runner cannot be reached.

### `RUNNER_SECRET`

The bearer secret between the API and worker on one side and the runner on the other.

- **Default:** derived from the session secret (HKDF-SHA256, salt `tracyhill-rp`, info `runner-secret`). Under Compose
  the init service writes the derived value to the `secrets` volume for the runner, so the runner never holds the
  session secret itself.
- **Read by:** the API, the worker, the init service (which writes nothing when it is set) and the runner
- **Compose:** listed for all four
- **When to set it:** for a runner on another host: set the same value for the API, the worker and the runner.
  `openssl rand -hex 32` prints a suitable value.

### `RUNNER_MEMORY_LIMIT`

The runner container's memory cap (Compose `mem_limit`). Every Claude turn runs a Claude Code process for its duration,
and every signed-in ChatGPT account keeps a Codex app server running while it is in use.

- **Default:** `3g`
- **Compose:** Compose only

### Runner-only variables

The runner reads these itself. The shipped Compose file sets the first three and passes none of the others, so set
those in a [`docker-compose.override.yml`](#override-file) under `tracyhill-rp-runner`.

| Variable | Default | What it does |
|---|---|---|
| `RUNNER_PORT` | `7710` | Listening port. Compose sets `7710`, which `RUNNER_URL` and the runner's healthcheck also use. |
| `RUNNER_DATA_DIR` | `/srv/subscriptions` | Where the credential homes live; the `subscriptions` volume is mounted here. |
| `RUNNER_SECRET_FILE` | `/run/tracyhill-secrets/runner.secret` | Where the init service writes, and the runner reads, the derived secret. |
| `RUNNER_CODEX_IDLE_MS` | `1800000` (30 minutes) | A signed-in account's Codex app server stops after this long unused. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `64000` | Handed to every Claude Code process the runner starts. |
| `MAX_BODY_BYTES` | `104857600` (100 MiB) | The largest request body the runner accepts. |
| `CODEX_BIN` | `apps/runner/node_modules/.bin/codex` | The Codex binary. |
| `CLAUDE_CLI_WRAPPER` | `apps/runner/cli-wrapper.sh` | The script that starts the SDK's bundled Claude Code binary (behind a pipe, which keeps very large inputs readable for it). |

The runner refuses to start when it has no secret at all (no `RUNNER_SECRET`, no `SESSION_SECRET`, and no secret file
from the init service). Its `/healthz` reports the versions of the two binaries.

---

## 5. Email

The server sends email for sign-up verification codes, forgot-password codes, email codes at sign-in
([§ 6](#6-two-factor-sign-in)), confirming the deletion of one's own account, and adding or changing an account's email
address. Without working email, the sign-in page offers neither sign-up nor forgot-password, administrators create
accounts or invite links and reset passwords in **Admin: Users**, and accounts cannot delete themselves or change
their email address.

### Setting it up in the app

In **Admin: Server settings → Email**, choose what to **Send email with**:

- **SendGrid:** an API key with the Mail Send permission.
- **SMTP:** the server's host name, its port and encryption, and a username and password if it needs them. STARTTLS
  (the default, usually port 587) upgrades the connection and refuses to send when the server cannot; TLS (usually
  port 465) encrypts from the first byte; None sends unencrypted, for a relay on a network you trust.

Enter the sender address (your provider may require it to be verified) and the sender name (blank uses
`TracyHill RP`), save, then use **Send test**. Email counts as working only after a test succeeds with exactly the
saved settings; any later change makes it untested until the next successful test. The SendGrid key and the SMTP
password are stored encrypted (see [`SESSION_SECRET`](#session_secret)).

### `SENDGRID_API_KEY`

Sends email through SendGrid with this key and takes precedence over the page: email counts as working without a test,
and the page shows the provider, the key and the SMTP fields locked.

- **Default:** unset (email comes from the page)
- **Read by:** the API
- **Compose:** listed for the API (blank)
- **Where to get one:** [app.sendgrid.com](https://app.sendgrid.com/settings/api_keys), with the Mail Send permission

### `EMAIL_FROM`

The sender address. Set here, it locks the sender address on the page.

- **Default:** unset: the address saved on the page. With `SENDGRID_API_KEY` set and no address anywhere, mail goes out
  from `noreply@example.com`, which SendGrid accepts only from a verified sender, so set a verified address.
- **Read by:** the API
- **Compose:** listed for the API (blank)

### `EMAIL_FROM_NAME`

The sender name. Set here, it locks the sender name on the page.

- **Default:** unset: the name saved on the page, else `TracyHill RP`
- **Read by:** the API
- **Compose:** listed for the API (blank)

### Moving email from `.env` into Server settings

A server that sends with `SENDGRID_API_KEY` (and possibly `EMAIL_FROM` and `EMAIL_FROM_NAME`) keeps doing so, with the
page locked. To hand email over to the page without a gap, run the adoption command in the app container once the
current version has started:

```bash
docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/adoptEnvEmailMain.ts --to <address>
```

It saves the values the server sends with today (including the defaults it falls back to) as the page's SendGrid
settings, the key encrypted, then sends a test email to `<address>` using only the stored copy, and records the result
with the same audit entries the page writes. Nothing secret is printed.

- **Exit 0:** the stored settings work on their own. Remove `SENDGRID_API_KEY`, `EMAIL_FROM` and `EMAIL_FROM_NAME` from
  `.env` and run `docker compose up -d`; the page then shows email from settings, working and unlocked. Until then the
  environment keeps winning.
- **Exit 2:** the test failed. The values are stored but unproven, so keep the `.env` lines until a test succeeds.
- **Exit 1:** the command stopped with an error and printed the reason, for example because `SENDGRID_API_KEY` is not
  set or `--to` is not a valid address.

---

## 6. Two-factor sign-in

Two-step sign-in has no environment variables. An administrator sets it in **Admin: Server settings → Two-factor**.

### Policy and methods

- **Off:** nobody is asked for a second step, even where one is set up.
- **Optional:** accounts that have a second step are asked for it; the others sign in with their password.
- **Required:** everyone is asked. Anyone without a second step sets up an authenticator app at their next sign-in,
  before reaching the app, administrators included. A trusted device skips the code, never the setup.

The methods are:

- **Authenticator app** (TOTP: six digits, 30-second steps, SHA-1; one step of clock drift is accepted either way, and
  each code works once). It needs no email. Required needs this method, because it is how someone without a second
  step sets one up.
- **Email codes:** a code sent at sign-in to every account whose email address is verified, while email works
  ([§ 5](#5-email)).

Optional and Required need at least one method. Authenticator codes depend on the server's clock, so keep it
synchronized.

When email stops working, nobody is asked for an email code. Under Optional an account whose only second step is email
then signs in with its password alone; under Required it is asked to set up an authenticator instead. Each such
sign-in records an error in the system events.

### Signing in

People set up an authenticator under **Options → MFA**: a QR code or the key to type, confirmed with a current code.
Setup shows ten one-time recovery codes once (they can be regenerated later and are stored hashed). At sign-in, after
the password, the person enters the authenticator code, a recovery code, or, where the server allows it, an email code.
"Trust this device" skips the second step on that device for 30 days, for up to 10 devices per account.

### Lost phone or locked out

An administrator resets someone's two-step sign-in in **Admin: Users** (Reset 2FA), which removes the authenticator,
the recovery codes and the trusted devices. For the administrator's own account, or when nobody can sign in, run the
recovery command in the app container:

```bash
docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name> --reset-two-factor
```

| Flag | Effect |
|---|---|
| `--user <name>` | The account to work on (letter case does not matter). Needed with the next two flags. |
| `--reset-two-factor` | Removes the account's authenticator, recovery codes and trusted devices. |
| `--new-password` | Sets a new random 16-character password, prints it once, and signs the account out everywhere. Change it afterwards under Options → Password. |
| `--two-factor-off` | Turns two-step sign-in off for the whole server; needs no `--user`. Restart the app afterwards (`docker compose restart tracyhill-rp`), because the API caches its settings. Turn it back on in Admin: Server settings once you are signed in. |
| `--help` | Lists the flags. |

Flags can be combined in one run. Every run writes an entry to the audit log.

---

## 7. Coding panels

Administrators can open three full-screen coding workspaces from the **Coding** menu (desktop layout): **Claude
Code**, **Kimi (K3)** and **Codex**. Each one drives an agent service that runs outside this app, on a machine you
choose; the API connects to it over HTTPS with a pre-shared secret. A panel gives this app's administrators a coding
agent on that machine, able to read and change files and run commands there as far as the agent's mode and its
operating-system account allow, so run each service under an account limited to what you want reachable.

**None is set up automatically.** A panel counts as set up when its host and secret are set (the port has a default;
the CA file is not part of this check). Until then:

- the Coding button shows greyed out when no panel is set up, and still opens its menu;
- each panel that is not set up is disabled in the menu ("Not set up on this server") and left out of the command
  palette, and its keyboard shortcut does nothing;
- the API records an info event at start for each panel that is not set up;
- **Admin: Server settings → Server** shows each panel as "Set up" or "Not set up".

To turn a panel on: run its agent service, make its CA certificate readable inside the API container, set the panel's
variables in `.env`, run `docker compose up -d`, and reload the app in the browser. All panel variables are read by the
API only.

### Making a CA file readable inside the container

The API checks each agent's certificate against the panel's `*_CA_PATH` file. The image contains no certificate
folder, and the shipped Compose file mounts only `./data`, so mount a folder with the CA files into the API container
with an override file:

```yaml
# docker-compose.override.yml
services:
  tracyhill-rp:
    volumes:
      - ./certs:/app/certs:ro
```

Put the CA files in `./certs` next to `docker-compose.yml` (readable by the app's user, UID 1001) and give each path
relative to `/app`, for example `CODEX_CA_PATH=certs/codex-panel.pem`; an absolute path inside the container works
too. Only the API needs them. Without a CA path the API accepts only certificates from the public authorities Node.js
trusts, and records a warning at start that the CA path is unset. A CA file that cannot be read does not stop the app:
the API records a warning at start, and every request to that panel fails with the reason.

### What each agent service must provide

- HTTPS on the panel's host and port. The API verifies the certificate against the CA file and sends the panel's
  `*_SERVERNAME` as the TLS server name; the certificate must carry that name (as a DNS subject alternative name). The
  host may be an IP address.
- Every request carries `Authorization: Bearer <the panel's secret>`, and bodies are JSON.
- The API opens a new connection for each request. JSON requests time out after 30 seconds (some Codex requests after
  120 seconds).

<a name="6-claude-code-admin-panel-optional-admin-feature"></a>

### Claude Code panel

The agent service for this panel is **not part of this repository**. It is an HTTPS service that runs Claude Code
sessions (for example through the Claude Agent SDK) and implements the panel's protocol: routes at the root of the
server, bodies as defined by the `claudeCode` schemas in `packages/contracts/src/claudeCode.ts`. The API's client for
it is `apps/api/src/domain/claudeCode/claudeCodeBridgeService.ts`.

| Method and path | Purpose |
|---|---|
| `GET /sessions`, `POST /sessions` | list sessions; send a message (a new session when the request names none) |
| `GET /sessions/<id>/messages`, `GET /sessions/<id>/status` | the transcript; the session's state |
| `PATCH /sessions/<id>`, `DELETE /sessions/<id>` | rename or pin a session; delete it |
| `GET /sessions/<id>/stream?after=<n>` | server-sent events, replayed from event index `n` |
| `POST /sessions/<id>/interrupt`, `/answer`, `/rewind`, `/mode`, `/approve-plan`, `/reject-plan`, `/compact`, `/fork` | session controls |
| `GET /sessions/<id>/doctor`, `/context`, `/commands`, `/export` | diagnostics, context usage, slash commands, a Markdown export |
| `GET /commands`, `GET /fs/tree?path=` | commands outside a session; the file tree |
| `GET /memory`, `GET /memory/read?path=`, `PUT /memory/write` | memory files |
| `POST /upload` | attachments |

The stream's events follow `claudeCodeStreamEventSchema`. A turn ends with an `event: done` frame and the replay of an
idle session with `event: stream_end`; the API reports an error to the browser when a stream closes without either.
Send keepalive comments regularly: the API gives up on a stream after 10 minutes without data.

| Variable | Default | Compose |
|---|---|---|
| `CLAUDE_CODE_HOST` | none (the panel is not set up) | listed |
| `CLAUDE_CODE_PORT` | `7702` | listed |
| `CLAUDE_CODE_SECRET` | none | listed |
| `CLAUDE_CODE_CA_PATH` | none (public authorities only) | listed |
| `CLAUDE_CODE_SERVERNAME` | `claude-agent` | listed |

<a name="6b-kimi-coding-panel-optional-admin-feature"></a>

### Kimi (K3) panel

The same workspace for Kimi K3. Its agent service is **not part of this repository** either: it implements the Claude
Code panel's protocol above with Kimi K3 as the model, plus three routes for how Kimi is served, `GET /serving`,
`POST /serving/probe` and `POST /sessions/<id>/serving`, with the modes `api` and `subscription` (the `kimiServing`
schemas in the same contracts file).

| Variable | Default | Compose |
|---|---|---|
| `KIMI_CODE_HOST` | none (the panel is not set up) | `.env` only |
| `KIMI_CODE_PORT` | `7704` | `.env` only |
| `KIMI_CODE_SECRET` | none | `.env` only |
| `KIMI_CODE_CA_PATH` | none (public authorities only) | `.env` only |
| `KIMI_CODE_SERVERNAME` | `kimi-agent` | `.env` only |

<a name="7-codex-panel-and-codexbridge-provider-optional"></a>

### Codex panel

The Codex panel's agent service ships with this repository: `tools/codex-agent-service`, a small Node.js service (no
npm dependencies) that runs the Codex CLI's app server and keeps the panel's sessions and a reconnectable event log.
The panel offers two modes, switchable during a session: **Read Only** (no file writes, no network) and **YOLO** (full
access to the machine as the service's account, with approvals off). Its workspaces are the folders sessions can start
in. The composer's `-codex-bridge` chat models do not use this service; they run on the
[subscription runner](#4-subscription-runner).

| Variable | Default | Compose | What it does |
|---|---|---|---|
| `CODEX_HOST` | none (the panel is not set up) | listed | the sidecar's host name or address, as the API container reaches it |
| `CODEX_PORT` | `7701` | listed | the sidecar's `AGENT_PORT` |
| `CODEX_SECRET` | none | listed | the sidecar's `AGENT_SECRET` |
| `CODEX_CA_PATH` | none (public authorities only) | listed | the sidecar's certificate, or the CA that signed it |
| `CODEX_SERVERNAME` | `codex-agent` | listed | the name the sidecar's certificate carries |
| `CODEX_TURN_LIMIT` | `40` | `.env` only | how many of a session's newest turns the panel loads |
| `CODEX_DESCENDANT_TURN_LIMIT` | `4` | `.env` only | how many newest turns it loads for each subagent thread |

The two limits bound what the panel shows at once and say so in the panel when turns are left out; the export always
contains the full history. A blank, zero or negative limit means the default.

### Running the Codex sidecar

On the machine that will run it, as the account it will run under:

1. Install Node.js (the app's images use version 20) and the Codex CLI (for example `npm install -g @openai/codex`;
   the version pinned in `apps/runner/package.json` is the one this release is built against).
2. Sign in to Codex once as that account (`codex login`; see `codex login --help` for the sign-in methods). Codex keeps
   the credential in that account's `~/.codex`, or in `CODEX_HOME` when that is set.
3. Copy `tools/codex-agent-service` from this repository to the machine.
4. Create its TLS key and certificate in its `certs` folder, under these exact names. A self-signed certificate for
   the default server name:

   ```bash
   cd codex-agent-service
   openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
     -keyout certs/agent-key.pem -out certs/agent-cert.pem \
     -subj "/CN=codex-agent" -addext "subjectAltName=DNS:codex-agent"
   chmod 600 certs/agent-key.pem
   ```

5. Start it with its variables (below), under a service manager that restarts it: the sidecar exits on an unexpected
   error and expects to be restarted. For example:

   ```bash
   AGENT_SECRET=<a long random value> ALLOWED_IPS=<the API's address as the sidecar sees it> node server.js
   ```

   It logs `Codex Agent Service v2 listening on https://0.0.0.0:7701` and the allowed addresses. It does not start
   without the two certificate files.

Then, on the Docker host:

1. Copy the sidecar's `certs/agent-cert.pem` to `./certs/codex-panel.pem` and mount `./certs` as shown in
   [Making a CA file readable inside the container](#making-a-ca-file-readable-inside-the-container).
2. In `.env`, set `CODEX_HOST` to the sidecar machine's address, `CODEX_SECRET` to the same value as `AGENT_SECRET`,
   and `CODEX_CA_PATH=certs/codex-panel.pem`. Keep `CODEX_PORT` and `CODEX_SERVERNAME` in step with `AGENT_PORT` and
   the certificate's name if you changed them.
3. Run `docker compose up -d` and reload the app.

**Which address to allow.** The sidecar compares the connection's source address exactly (no ranges). When it runs on
another machine than Docker, that is normally the Docker host's own address. When it runs on the Docker host itself,
it is normally the API container's address on the Compose network, which can change when the container is recreated.
This command shows the current one:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' tracyhill-rp
```

### Sidecar variables

The sidecar reads its own variables; it does not read the app's `.env`. Its `ALLOWED_IPS` is unrelated to the app's
variable of the same name. Its data (the session list and the event logs) is kept in its own `data` folder.

| Variable | Default | What it does |
|---|---|---|
| `AGENT_PORT` | `7701` | HTTPS port |
| `AGENT_SECRET` | none | the bearer secret; until it is set every request is refused (401) |
| `ALLOWED_IPS` | `127.0.0.1,::1,::ffff:127.0.0.1` | comma-separated source addresses allowed to connect, compared exactly after removing a `::ffff:` prefix; anything else gets 403 |
| `CODEX_BIN` | `codex` | the Codex CLI to run |
| `WORKSPACES_JSON` | the account's home folder plus each folder in `~/projects` | the workspaces, as JSON: `{"notes": {"name": "Notes", "cwd": "/srv/notes"}}` |
| `UPLOAD_DIR` | `/tmp/codex-uploads` | files attached in the panel; a file a turn used is removed 2 hours later, an unused one 24 hours after upload |
| `COMPOSER_DIR` | `/tmp/codex-composer` | working folder of the sidecar's composer endpoint, which this release of the app does not call |
| `MAX_BODY_BYTES` | `83886080` (80 MiB) | the largest request body; one upload is also limited to 20 MB |
| `EVENTS_RETENTION_DAYS` | `30` | the event log of a session untouched this long is cut down to a stub |
| `EVENTS_MAX_MB` | `500` | when all event logs together exceed this, the oldest inactive ones are cut first |
| `LIVE_EVENTS_MAX_MB` | `4` | how much of a running turn's events one session read or stream subscriber may carry |
| `BOOT_COMPACT_MIN_MB` | `8` | event logs larger than this are compacted once at start |

---

## 8. First-run setup and development

### First-run setup

A deployment with no accounts opens a setup page instead of the sign-in page. While no account exists, the API prints
a one-time setup code in its log at every start:

```bash
docker compose logs tracyhill-rp | grep -A 2 "setup code"
```

- The code has twelve characters in three groups (`XXXX-XXXX-XXXX`), drawn from letters and digits without look-alikes
  (no 0, O, 1, I, L or U). Letter case, dashes and spaces do not matter when you type it.
- It exists only in the API's memory and its log. Every restart prints a new one (the newest in the log is the one
  that works), and it stops working once any account exists.
- Ten wrong codes from one address lock that address out of setup for 15 minutes. Behind a reverse proxy, the address
  is the one [`TRUST_PROXY`](#trust_proxy) yields.

The setup page then:

1. asks for the code;
2. creates the first administrator (a username of 2 to 30 letters, digits, `-` or `_`, and a password of at least 8
   characters with an upper-case letter, a lower-case letter and a digit) and signs them in. The server records the
   setup browser's time zone for the daily sign-out (3 AM there; see [`TZ`](#tz)) and the new server's settings (see
   [Servers that predate Server settings](#servers-that-predate-server-settings));
3. asks for at least one model provider for the administrator's own account: an API key, or a sign-in to a Claude or
   ChatGPT subscription. **Finish setup** turns on once one is connected, and **Skip for now** leaves it for later
   (Options → Providers). A key entered here belongs to the administrator's account only; to share one with every
   account, use Admin: Server settings → Shared keys.

The page warns when it is opened over plain HTTP from another machine. Nothing configures first-run setup; it ends
when the first account exists. Of two setup forms sent at once, one wins.

### `SEED_DEMO_USER`

Development only. On a database with no accounts, the API creates an administrator from `DEMO_USERNAME` and
`DEMO_PASSWORD` at start, so first-run setup never appears.

- **Default:** `0`
- **Read by:** the API
- **Compose:** listed for the API (`0`)
- **Notes:** once any account exists it does nothing: it never creates a second account and never resets the password.
  Turning it off later leaves the account in place, still an administrator with whatever password it has; change the
  password (Options → Password) or delete the account (Admin: Users) before anyone else can reach the server. Because
  the account does not come from first-run setup, the server's settings take the older defaults described under
  [Servers that predate Server settings](#servers-that-predate-server-settings) from the API's next start.
- **Security:** the default credentials are public knowledge. Never turn this on for a server other people can reach.

### `DEMO_USERNAME`

Username of the seeded administrator.

- **Default:** `demo` (its email address is set to `<username>@example.com`, unverified)
- **Compose:** listed for the API

### `DEMO_PASSWORD`

Password of the seeded administrator. The seed does not apply the password rules.

- **Default:** `demo-pass`
- **Compose:** listed for the API

### `MOCK_PROVIDER`

With `1`, the API answers chat turns and image requests with built-in mock runtimes, the worker runs pipeline jobs on
a mock chat runtime, and the campaign wizard uses a deterministic stand-in, for fixture tests and interface work. It
does not isolate the server from the network: embeddings, email, the coding panels and subscription sign-ins still use
their real services, so keep real credentials and endpoints out of a test environment.

- **Default:** `0`
- **Values:** `0` or `1`
- **Read by:** the API and the worker
- **Compose:** listed for the API and the worker (`0`)

### `EXPOSE_AUTH_CODES`

Development only. With `1`, the verification codes for sign-up, forgot-password, sign-in, account deletion and email
changes are returned in the API's responses (and also emailed when email works), and the features that need email
count as available without it, so those flows can be tried without an email service.

- **Default:** `0`
- **Read by:** the API
- **Compose:** listed for the API (`0`)
- **Production guard:** with `NODE_ENV=production` the API refuses to start while it is `1`. The shipped Compose file
  sets production, so it cannot be used there.
- **Security:** never enable it outside local development: it hands verification codes to whoever makes the request.

### `NODE_ENV`

The standard Node.js environment switch.

- **Compose:** set to `production` for the API, the worker and the runner; the images also set it, which covers the
  init service.
- **`production`:** `EXPOSE_AUTH_CODES` is refused, and a model-catalog error at start (such as an invalid
  `DEFAULT_MODEL_ID`) is logged and recorded in the system events instead of stopping the API.
- **`test`:** for automated tests only. When `SESSION_SECRET` is unset the API uses a fixed, publicly known secret
  instead of generating one, skips the cross-site request (Origin) check, and skips the runner check at start. Never
  run a reachable server with it.
- **Anything else** (local development): a model-catalog error stops the API at start, and `EXPOSE_AUTH_CODES` works.

---

## Related reading

- [`README.md`](README.md): installation, the feature tour and the architecture
- [`SECURITY.md`](SECURITY.md): the security model and how to report a vulnerability
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release
- [`LICENSE`](LICENSE)
