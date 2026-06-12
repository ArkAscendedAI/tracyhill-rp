# v2 Architecture

**V2 is in production** since 2026-04-13. V1 is retired.

## Workspace Layout
```text
apps/
  web/
  api/
  worker/

packages/
  contracts/
  db/
  model-catalog/
  provider-runtime/
  logging/
  test-fixtures/

tools/
  codex-agent-service/
  expand-lorebook-keys.ts
  import-lorebook.ts
  reembed-stale-threads.ts
```

## Ownership
- `apps/web`: user-facing UI only (React 18 + Vite)
- `apps/api`: HTTP surface, auth/session cookies, sync CRUD, streaming entrypoints, image serving, enqueueing jobs, context engine, scene parser
- `apps/worker`: pipeline and wizard execution, retries, durable job transitions, plus the V3 lorebook maintenance jobs — rolling-diff lorebook updates, narrative thread tracking, consolidation, tiered archival, repetition detection, and system-prompt audits
- `packages/contracts`: shared request/response schemas and stream-event types (Zod)
- `packages/db`: SQLite client (Drizzle ORM + better-sqlite3), schema, migrations
- `packages/model-catalog`: chat/image model metadata, capabilities, pricing
- `packages/provider-runtime`: provider request builders, parsers, usage extraction, truncation detection, registry (Anthropic, OpenAI, Google, xAI, z.ai, DeepSeek, custom)
- `packages/logging`: structured logger factory, redaction, correlation helpers
- `packages/test-fixtures`: seed data and test fixtures

## Storage Model
- SQLite for structured state
- disk for generated images and other large binary artifacts when appropriate
- importer from `v1` file layout into fresh `v2` targets

## API Direction
- no provider-specific frontend proxy routes in `v2`
- one unified chat contract
- one unified image-generation contract
- one job-backed pipeline/wizard contract family
- session model/provider choice is persisted in workspace state, not kept as transient UI-only state

## Logging Direction
- operational logs: structured JSON to stdout
- audit events: DB-backed `audit_events`
- Docker rotation caps enforce hard disk budgets
