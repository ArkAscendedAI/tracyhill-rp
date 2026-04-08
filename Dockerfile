# Stage 1: Build the React frontend
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-update-notifier
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine

WORKDIR /app

# Only copy what we need for production
COPY package.json package-lock.json* ./
RUN npm install --no-update-notifier --omit=dev

COPY server.js set-password.js ./
COPY server/ ./server/
COPY --from=builder /app/dist ./dist

# Data directory for password hash + state (mount as volume)
RUN mkdir -p /app/data

# Create non-root user — set APP_UID/APP_GID to match your host user
# so volume mounts are natively readable without chown
ARG APP_UID=1001
ARG APP_GID=1001
RUN addgroup -g ${APP_GID} -S app && adduser -u ${APP_UID} -S app -G app
RUN chown -R app:app /app
USER app

EXPOSE 3000

ENV NODE_ENV=production
ENV TRUST_PROXY=true

CMD ["node", "server.js"]
