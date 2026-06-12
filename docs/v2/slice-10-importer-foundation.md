# Slice 10: Importer Foundation

## Goal
- establish a first real `v1` -> fresh `v2` importer path instead of leaving Slice 10 at planning-only status

## Delivered In This Increment
- added a typed importer module at `apps/api/src/importer/v1Importer.ts`
- added a CLI entrypoint at `apps/api/src/importer/cli.ts` plus `npm run import:v1 --workspace @tracyhill-rp/api`
- added read-only `--report` comparison mode for normalized source-versus-target validation
- added a synthetic `v1` fixture builder at `packages/test-fixtures/src/v1ImportFixture.ts`
- added focused importer coverage at `apps/api/src/importer/v1Importer.test.ts`
- expanded `sessions` with standalone `system_prompt` and `state_seed` columns so imported non-campaign sessions do not lose prompt context
- updated chat runtime fallback so standalone imported sessions still dispatch with their own prompt/seed when no linked campaign exists

## Imported Now
- `users.json` -> users
- `meta.json` -> user preferences and folders
- `sessions_meta.json` + `sessions/*.json` -> sessions, messages, message attachments, generated-image metadata
- `pending/*.json` -> pending assistant recovery state
- `pipelines/*.json` -> historical pipeline/job rows in `pipeline_runs`
- `campaigns.json` -> campaigns
- `campaign_versions/*` -> campaign versions
- `wizard_templates.json` -> wizard templates
- `apikeys.json` -> provider keys and custom endpoints
- generated image files under `images/*` -> copied into the `v2` image store

## Explicitly Deferred In This Increment
- production-shaped repeated validation runs

## Report Mode
- compares normalized source data against an existing `v2` target DB plus image store
- reports per-domain `missing`, `extra`, and `changed` keys across:
  - users
  - preferences
  - folders
  - sessions
  - messages
  - attachments
  - pending assistant messages
  - pipeline runs
  - generated images
  - copied image files
  - campaigns
  - campaign versions
  - wizard templates
  - provider keys
  - custom endpoints
- intentionally ignores importer-generated timestamp noise on wizard templates, provider keys, and custom endpoints so drift detection stays focused on preserved data rather than import time

## Hidden Gap Exposed During Importer Work
- current `v1` standalone sessions still persist `systemPrompt` and `stateSeed` directly on the session object
- pre-increment `v2` chat runtime only respected wizard or campaign prompt context
- importing standalone sessions without a schema/runtime correction would have silently changed behavior after migration
- this increment closes that gap by persisting standalone session prompt context in SQLite and using it during runtime dispatch when no campaign is linked

## Verification
- `npm test --workspace @tracyhill-rp/api -- v1Importer.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 10 Work
- run repeated production-shaped imports against fresh targets
- build formal parity-gate evidence on imported data
- prove packaging, retention, rollback, and cutover-readiness gates
