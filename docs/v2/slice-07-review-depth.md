# Slice 7 Parity Follow-up: Review Depth

## Scope
This parity follow-up narrows the remaining Slice 7 gap by restoring a clearer separation between system-prompt review recommendations and the final applied system prompt draft.

Implemented here:
- Step 3 review output now persists as a recommendation/diff-style artifact instead of being conflated with the applied draft
- applied system-prompt output now persists separately in review state
- no-change outcomes now stay explicit instead of fabricating an applied revision note
- retry flows preserve the richer system-prompt review/apply state across derived runs
- campaign review UI now renders system-prompt review output separately from the applied system prompt
- route, worker, typecheck, build, unit, and browser coverage all stay green with the narrower semantics

## Notes
- Slice 7 operator-control parity remains closed
- the remaining Slice 7 gap after this increment was the narrower operator-guidance/partial-failure depth tracked in `docs/v2/slice-07-operator-guidance.md`
- the next larger product gap is still Slice 8's session-driven, transcript-backed wizard flow

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
