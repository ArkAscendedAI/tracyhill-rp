# Slice 1: Foundation

## Goal
Make `v2` real enough to build on:
- workspaces in place
- TypeScript in place
- SQLite boots and migrates
- `api` serves `health`, `login`, `logout`, `me`
- `web` renders login and authenticated shell
- logging foundation exists
- docs and memory are persisted

## Non-Goals
- sessions/folders
- chat streaming
- providers beyond auth/system shell
- campaigns, pipeline, wizard
- admin and bridges

## Package/App Targets
- root workspace conversion
- `packages/contracts`
- `packages/db`
- `packages/logging`
- `packages/test-fixtures`
- `apps/api`
- `apps/web`

## Locked Task Order
1. root workspace bootstrap
2. contracts package
3. db package and migration runner
4. logging package scaffold
5. test fixtures package
6. api scaffold + system route
7. auth domain + auth routes
8. web scaffold + auth shell
9. tests
10. docs and memory

## Acceptance Criteria
- root workspace commands resolve
- contracts are shared by `web` and `api`
- SQLite migrates cleanly
- `/api/system/health` works
- `/api/auth/login` works
- `/api/auth/logout` works
- `/api/auth/me` works
- login/logout browser smoke flow works
- request correlation logging exists
- docs and memory reflect the real state

## Stop Conditions
- SQLite driver/runtime friction forces a different container base
- cookie auth across dev ports needs a proxy adjustment
- workspace changes threaten `v1` ergonomics
- shared git state introduces conflicts that require coordination first
