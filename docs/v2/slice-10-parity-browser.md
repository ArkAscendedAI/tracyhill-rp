# Slice 10: Imported-Data Browser Parity

## Goal
- prove imported `v1` data survives through the actual browser UI on top of the real importer path instead of stopping at route or service verification

## Delivered In This Increment
- added a reusable importer-fixture seeding script at `apps/api/src/importer/seedImportedFixture.ts` for browser-oriented imported-data verification
- added a dedicated Playwright config for imported-data smoke at `apps/web/playwright.imported.config.ts`
- added browser smoke coverage for imported data across:
  - login as an imported user
  - imported sessions in the sidebar
  - imported attachments in session detail
  - imported campaign/version visibility
  - imported provider-key/custom-endpoint visibility
  - continued chat on an imported campaign-backed session

## Why This Matters
- Slice 10 parity evidence now spans importer normalization, direct services, authenticated routes, and the real browser shell
- this imported-data browser evidence now sits inside the fully closed Slice 10 package after the later packaging/retention/rollback proof landed

## Verification
- `npx playwright test --config apps/web/playwright.imported.config.ts apps/web/e2e/imported-parity.spec.ts`
- `npm test --workspace @tracyhill-rp/api -- v1Importer.test.ts v1ImportParityRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Final Status
- the imported-data browser gate remains part of the final closed Slice 10 verification set
