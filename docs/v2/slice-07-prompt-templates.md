# Slice 7 Increment: Campaign Prompt Templates

## Scope
This is the fourth completed increment inside Slice 7, not the full slice.

Implemented here:
- campaign-owned `updatePromptTemplate` and `systemPromptUpdateTemplate` persisted in SQLite and exposed through shared contracts
- campaign-panel create/edit support for both prompt-template fields
- worker runtime execution now honors campaign-specific prompt templates when provider runtimes are configured
- compact shared `v2` prompts remain the fallback when campaign-specific templates are blank
- route and browser coverage proving custom prompt templates persist through campaign CRUD and the expanded campaign flow

## Notes
- this increment moves Slice 7 closer to the `v1` campaign model by restoring campaign-specific pipeline prompt ownership
- auto-fix, surgical edit application, and richer retry semantics are still outstanding

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
