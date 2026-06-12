# Slice 4 Increment: Binary Attachments

## Scope
This increment expands the earlier text-first attachment baseline.

Implemented here:
- explicit attachment content modes in shared chat contracts
- SQLite persistence for attachment content mode metadata
- image and PDF uploads in the active chat composer
- image previews in the composer and conversation history
- preserved binary attachments in session detail payloads
- text-only provider prompt formatting that uses clear placeholders for non-text attachments
- browser coverage for upload, send, and conversation render of an image attachment

## Notes
- this increment establishes a safe normalized binary-attachment baseline for `v2`
- non-text attachments are preserved end-to-end even when the active runtime is text-only
- richer provider-native multimodal dispatch can be added later if parity work proves it is required

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
