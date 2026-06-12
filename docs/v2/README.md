# TracyHill RP v2

**V2 is in production** since 2026-04-13. V1 is retired.

Stack:
- TypeScript monorepo (npm workspaces)
- React 18 + Vite frontend
- Express HTTP API
- SQLite (Drizzle ORM, better-sqlite3, WAL)
- Worker-backed pipeline + wizard (inline in API process via INLINE_WORKERS=1)
- Structured logging (pino) + DB-backed audit events
- Lorebook-centric context engine (V3) with keyword/semantic/researcher activation

Per-slice engineering docs:
- `docs/v2/architecture.md` — workspace layout and ownership
- `docs/v2/db-schema.md` — table shapes and relationships
- `docs/v2/testing.md` — test strategy
- `docs/v2/logging.md` — logging and audit
- `docs/v2/slice-01-foundation.md` through `slice-10-*.md` — implementation details per slice
- `docs/v2/github-release-sidebar.md` — public GitHub push structure
