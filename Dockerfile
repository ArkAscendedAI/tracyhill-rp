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
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
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

CMD ["npm", "run", "start:api"]
