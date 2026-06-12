# Slice 2 Parity Follow-up: Sidebar Drag And Drop

## Scope
This increment restores `v1`-style drag-and-drop moves for standard sessions in the sidebar.

Implemented here:
- standard session cards are now draggable in the sidebar
- folder cards accept dropped sessions and move them into that folder
- the unfiled session section accepts dropped sessions and moves them back to root
- sidebar styling now highlights active drop targets and dragged sessions
- browser coverage now verifies an unfiled session can be dragged into a folder

## Notes
- this closes the drag-and-drop portion of the old broader Slice 2 organization gap
- Slice 2 still has confirmed parity work remaining around nested folder hierarchy and fuller sidebar/footer chrome

## Acceptance Evidence
- `npm run typecheck`
- `npm run build`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts apps/web/e2e/sidebar-dnd.spec.ts`
