# Slice 6 Parity Follow-up: Pipeline Archive Side Effects

## Scope
This increment restores the missing `v1` pipeline enqueue side effects around the source campaign session.

Implemented here:
- first-run pipeline enqueue now archives the latest campaign-linked standard session before worker execution starts
- archived source sessions are renamed to `Part {campaign.version} (YYYY-MM-DD)`
- archived source sessions move into the linked campaign folder when the campaign has one
- retry runs do not re-archive or re-rename the source session
- campaign-panel enqueue success now refreshes workspace state so the shell reflects the renamed/moved session immediately
- route and browser coverage now verify the enqueue-side archive behavior

## Notes
- this restores the missing pipeline-side organizational behavior that `v1` applies before the long-running review flow
- the archive name follows the campaign version, matching the current `v1` behavior oracle
- this re-audit also exposed a narrower remaining Slice 6 gap: regular campaign CRUD still does not expose editable folder linkage, even though campaigns can persist `folderId` and wizard-created campaigns already use it

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- pipelineRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts`
