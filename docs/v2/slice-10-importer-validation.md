# Slice 10: Importer Validation

## Goal
- move the importer from narrow synthetic proof toward repeatable production-shaped validation evidence

## Delivered In This Increment
- expanded the importer fixture coverage to a broader multi-user `v1` tree with:
  - multiple users
  - multiple campaigns
  - multiple generated-image files and mime types
  - multiple wizard-template rows
  - multiple provider-key rows
  - both completed and failed historical pipeline runs
- added repeated validation coverage proving the same production-shaped source can:
  - dry-run cleanly
  - import into one fresh `v2` target
  - report cleanly against that imported target
  - import into a second fresh `v2` target
  - report cleanly again
  - re-import into the first target without drift

## Why This Matters
- Slice 10 now has stronger evidence that importer normalization is stable across fresh-target copies instead of only one narrow happy-path fixture
- importer coverage now exercises more of the mixed real-world `v1` state shape at once without claiming production cutover readiness

## Verification
- `npm test --workspace @tracyhill-rp/api -- v1Importer.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 10 Work
- build the formal parity-gate suite on imported data
- prove packaging, retention, rollback, and cutover-readiness gates
