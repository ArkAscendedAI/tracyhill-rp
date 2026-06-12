# Slice 10: Imported-Data Parity Verification

## Goal
- start the formal Slice 10 parity-gate evidence on top of imported `v1` data instead of stopping at importer counts and drift checks

## Delivered In This Increment
- added imported-data parity coverage that exercises the real `v2` service layer after import, not just importer table counts
- the new verification now proves imported production-shaped data is usable through:
  - workspace state
  - campaign list and version history
  - pipeline review history
  - provider-key/custom-endpoint visibility
  - chat session detail, attachment visibility, generated-image references, and continued runtime dispatch with imported campaign prompt context

## Why This Matters
- Slice 10 now has the first bounded formal parity evidence on imported data itself
- this still does not claim cutover readiness; it proves imported state survives into real `v2` behavior surfaces rather than only landing in the right rows

## Verification
- `npm test --workspace @tracyhill-rp/api -- v1Importer.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 10 Work
- expand the parity gate beyond the current imported service-layer coverage
- prove packaging, retention, rollback, and cutover-readiness gates
