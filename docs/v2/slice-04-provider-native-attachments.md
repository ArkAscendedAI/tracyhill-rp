# Slice 4 Parity Follow-up: Provider-Native Chat Attachments

## Scope
This parity follow-up closes a hidden Slice 4 gap that the earlier normalized binary-attachment increment did not solve completely.

Implemented here:
- stored attachments now stay attached to their original user messages across later chat turns instead of only being present on the just-submitted request
- Anthropic chat runtime now sends native image and PDF blocks
- OpenAI Responses chat runtime now sends native image and PDF inputs
- Google Gemini chat runtime now sends native image and PDF `inlineData` parts
- xAI and zAI chat runtimes now send native image inputs and `v1`-style PDF warning text when PDF input is unsupported
- provider-runtime coverage now asserts multimodal payload shape directly

## Notes
- this follow-up restores built-in provider chat attachment behavior much more closely to `v1`
- the main attachment gap that surfaced during the re-audit was historical context loss: earlier attachments were being flattened away on later sends
- later Slice 4 follow-ups closed the remaining audited provider-behavior scope, so only Slice 10 cutover work remains confirmed

## Acceptance Evidence
- `npm test --workspace @tracyhill-rp/api -- chatRoutes.test.ts`
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm run typecheck`
- `npm test`
- `npm run build`
