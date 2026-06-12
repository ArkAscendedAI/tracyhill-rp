# Slice 10: Imported-Data Route Parity

## Goal
- push Slice 10 parity evidence one boundary outward by verifying imported `v1` data through authenticated `v2` HTTP routes, not just importer counts or direct service calls

## Delivered In This Increment
- added authenticated route coverage on top of imported production-shaped data for:
  - workspace state
  - campaigns and version history
  - pipeline review history
  - provider keys and custom endpoints
  - chat session detail plus continued streaming on imported campaign-backed sessions
- the route coverage also proves imported campaign prompt context still reaches runtime dispatch through the normal HTTP chat path

## Why This Matters
- Slice 10 parity evidence now spans importer normalization, direct service behavior, and authenticated route surfaces
- this still does not claim final cutover readiness; it is another bounded step toward the broader parity gate

## Verification
- `npm test --workspace @tracyhill-rp/api -- v1Importer.test.ts v1ImportParityRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 10 Work
- expand the parity gate beyond the current imported service and route coverage
- prove packaging, retention, rollback, and cutover-readiness gates
