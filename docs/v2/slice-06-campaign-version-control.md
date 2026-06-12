# Slice 6 Parity Follow-up: Campaign Version Control

## Scope
This is a bounded Slice 6 parity follow-up, not a new foundational increment.

Implemented here:
- manual current-version control in campaign create and edit flows
- `v1`-style `version = 0` default for manually created campaigns
- explicit version overrides that coexist with the existing auto-increment path when operators do not set a version manually
- restore-route support for archived `v0` content
- pipeline archive naming correction to match `v1` enqueue behavior: source sessions archive as `Part {campaign.version + 1} (YYYY-MM-DD)`

## Notes
- the manual campaign-manager path now matches the current in-repo `v1` behavior more closely for existing-data seeding and later version corrections
- content edits still archive the prior campaign state before writing the new current state
- restore remains monotonic in `v2`; restoring archived content still creates a new current version instead of rewinding the counter
- the `v1` re-audit during this increment exposed an off-by-one archive-name defect in the earlier `v2` pipeline archive implementation; this increment fixes that defect instead of leaving it as a newly discovered open gap

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- campaignRoutes.test.ts pipelineRoutes.test.ts`
- `npm run typecheck`
