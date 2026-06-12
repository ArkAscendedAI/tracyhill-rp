# Slice 8 Parity Follow-up: Transcript Context

## Scope
This parity follow-up restores transcript-backed wizard generation without waiting for the full session-slot rewrite.

Implemented here:
- wizard runs now persist an explicit `wizardTranscript` alongside the earlier short `brief`
- worker generation now sends `<wizard_conversation>...</wizard_conversation>` to all four wizard generation steps
- retries preserve the same transcript context instead of falling back to a reduced summary
- the campaign-panel wizard UI now accepts a pasted transcript directly
- when only a short brief is provided, `v2` synthesizes a minimal transcript so the worker still runs through the transcript-shaped path
- route, worker, typecheck, build, full test, and browser smoke coverage are green

## Notes
- this closes the brief-only generation gap, but not full `v1` wizard parity
- the remaining major Slice 8 gap is still the dedicated wizard session lifecycle:
  - sidebar wizard slot
  - conversation-driven context accumulation
  - `[WIZARD_READY]` gating
  - active/cancel/discard flow
  - wizard-session cleanup on approval

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
