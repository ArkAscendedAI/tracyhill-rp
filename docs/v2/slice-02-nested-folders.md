# Slice 2 Parity Follow-up: Nested Folders

## Scope
This increment restores the remaining audited Slice 2 folder-hierarchy behavior from `v1`.

Implemented here:
- workspace folders now persist optional `parentId`
- the sidebar now renders folders recursively instead of as a flat list
- new-session, move-session, campaign-folder, and folder-edit selectors now show nested folder paths
- folder delete now re-homes direct sessions, child folders, and linked campaign-folder references to the deleted folder's parent
- server-side validation now blocks self-parenting, subtree cycles, and folder trees deeper than the `v1` four-level limit

## Notes
- this closes the remaining audited Slice 2 parity gap
- the re-audit also exposed a touched-surface ambiguity in campaign/session folder selectors once nesting returned, so those selectors now render full nested labels instead of flat names

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- workspaceRoutes.test.ts`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/sidebar-nested-folders.spec.ts`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
