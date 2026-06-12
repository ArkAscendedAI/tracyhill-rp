# Slice 10: Packaging, Retention, Rollback, Cutover Proof

## Goal
- close the last operational Slice 10 gap by proving `v2` has a real deployable package path, worker-safe runtime wiring, log-retention caps, backup retention evidence, and rollback-ready deploy mechanics

## Delivered In This Increment
- replaced the stale repo-root `v1` container path with a real `v2` workspace image in `Dockerfile`
- added root runtime scripts for packaged `api` and `worker` entrypoints
- taught the `api` to serve the built `apps/web/dist` shell for non-`/api` routes
- added `INLINE_WORKERS` and `WEB_DIST_DIR` env handling so packaged prod mode can disable inline workers while still serving the built web shell
- made running pipeline and wizard cancel requests safe for a dedicated worker process by:
  - letting the `api` mark running jobs canceled in SQLite when no inline worker owns the abort controller
  - teaching both worker loops to watch their own DB rows and abort in-flight runtime calls when that cancel state appears
- replaced the stale single-service repo compose with a shared two-service base:
  - `tracyhill-rp` API
  - `tracyhill-rp-worker`
- added repo-tracked prod/test compose overlays in `deploy/`
- added Docker log-retention caps at the compose layer
- updated the shared deploy scripts so test/prod deploys now use the repo-tracked v2 compose overlays instead of host-private compose copies

## Why This Matters
- Slice 10 no longer stops at importer/parity evidence while leaving deployment on the old `server.js` container path
- the packaged stack now matches the documented v2 shape closely enough for audited cutover-readiness evidence:
  - built web shell
  - API service
  - dedicated worker service
  - shared SQLite/image volume
  - Docker log retention caps
  - repo-tracked deploy overlays
- rollback evidence is now tied to the real shared deploy scripts that still tag each deploy and can redeploy a prior tagged ref while using the repo-tracked v2 compose path
- retention evidence is now anchored by the existing `backup-tracyhill-rp` tiered backup script plus Docker log caps, instead of being left as an undocumented assumption

## Verification
- `npm test --workspace @tracyhill-rp/api -- systemRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/worker -- pipelineWorker.test.ts wizardWorker.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`
- `npx playwright test --config apps/web/playwright.imported.config.ts apps/web/e2e/imported-parity.spec.ts`
- `docker build -t tracyhill-rp-v2-slice10-proof .`
- packaged-stack smoke:
  - API health via `GET /api/system/health`
  - built SPA shell via `GET /`
  - dedicated worker startup via `npm run start:worker` inside the packaged image
- deploy-host tooling proof:
  - `ssh <deploy-host> 'docker compose version'`

## Operational Evidence
- prod deploy script still creates `deploy-YYYYMMDD-HHMMSS` tags and supports explicit rollback refs
- test deploy script still creates deploy tags before test rollout
- `backup-tracyhill-rp` still enforces:
  - all 15-minute snapshots for 24 hours
  - 4-hour boundary snapshots for 30 days
  - off-host Utility VM copies
  - AWS-backed daily protection via the Utility path

## Slice 10 Result
- Slice 10 is now closed inside the audited implementation/parity scope
- importer, parity verification, packaging, retention validation, and rollback/cutover-proof evidence now all exist in-repo or in the shared deploy tooling
- the final verification stack now includes unit/integration, full default browser smoke, and dedicated imported-data browser smoke on the same closed state
