# Slice 8 Parity Follow-up: Review Surface

## Scope
This parity follow-up closes the remaining Slice 8 review UX gap by restoring a dedicated wizard review surface instead of leaving review trapped inside the campaign panel.

Implemented here:
- dedicated wizard review dialog reachable from shell-level wizard activity and campaign-panel wizard status
- `v1`-style review structure with campaign name, model/status/elapsed metadata, step indicators, transcript visibility, and tabbed document review
- editable review drafts for:
  - campaign name
  - state seed
  - system prompt
  - seed update prompt
  - system prompt update prompt
- approval wiring that persists those edited drafts into the approved campaign/folder/`Part 1` session instead of ignoring operator edits
- route, typecheck, full test, build, and browser coverage for edited approval through the dedicated review surface

## Notes
- this closes the last confirmed Slice 8 parity gap
- the campaign panel still keeps wizard management and latest-run visibility, but review is no longer campaign-panel-only
- Slice 8 should now be treated as complete inside the audited scope; the next major product gap is Slice 9

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- wizardRoutes.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
