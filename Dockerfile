FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/model-catalog/package.json packages/model-catalog/package.json
COPY packages/provider-runtime/package.json packages/provider-runtime/package.json
COPY tools/codex-agent-service/package.json tools/codex-agent-service/package.json

RUN npm ci --include=dev --no-update-notifier

FROM deps AS build

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app ./

RUN mkdir -p /app/data/v2/images && chown -R 1001:1001 /app/data

USER 1001

EXPOSE 3000

# node as PID 1 so `docker stop`'s SIGTERM reaches the API's shutdown handler
# without depending on npm/sh forwarding it. Same command
# as the root `start:api` script; compose sets the worker's command explicitly.
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]

# ── Subscription runner ─────────────────────────────────────────────────────
# A separate, glibc-based stage: it carries the two official binaries the
# composer's subscription paths run — the Agent SDK's bundled Claude Code and
# the Codex CLI — installed from npm at build time under their own licenses,
# never committed. The API image never carries them. Its data lives OUTSIDE
# /app (/srv/subscriptions) so no repository file is an ancestor of a per-user
# working directory.
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# ca-certificates: node ships its own root store, but the Codex binary (Rust) and
# the Claude Code binary read the system store — without it every request to
# the providers fails with "error sending request" (found 2026-09-25).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -m -s /usr/sbin/nologin appuser

COPY apps/runner/package.json apps/runner/package-lock.json apps/runner/
RUN cd apps/runner && npm ci --omit=dev --no-audit --no-fund --no-update-notifier

COPY apps/runner apps/runner
COPY tools/codex-agent-service/lib tools/codex-agent-service/lib

RUN chmod +x apps/runner/cli-wrapper.sh \
  && mkdir -p /srv/subscriptions \
  && chown -R 1001:1001 /srv/subscriptions /app/apps/runner

USER 1001

ENV RUNNER_DATA_DIR=/srv/subscriptions
ENV RUNNER_PORT=7710

EXPOSE 7710

CMD ["node", "apps/runner/server.js"]
