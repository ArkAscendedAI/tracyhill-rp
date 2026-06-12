# Slice 6 Parity Follow-up: Campaign Folder Linking In Campaign Manager

## Scope
This increment restores manual campaign-folder linkage through the regular campaign manager path.

Implemented here:
- campaign create and update contracts now accept optional `folderId`
- campaign service now validates linked folders for regular create/edit flows instead of silently dropping the field
- campaign manager now exposes linked-folder selection during both create and edit
- campaign cards now show the currently linked folder
- regular campaign-created folder links now flow into start-session behavior the same way wizard-created campaigns already did
- route and browser coverage now verify manual linked-folder creation, editing, visibility, and downstream session-launch behavior

## Notes
- this closes the narrower manual-folder-linking gap exposed by the prior enqueue-archive parity work
- Slice 6 is still not fully identical to `v1`; the remaining confirmed gap is broader campaign-manager workflow/UX depth rather than missing folder-link plumbing

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- campaignRoutes.test.ts workspaceRoutes.test.ts`
- `npm run typecheck`
- `npm run build`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts`
