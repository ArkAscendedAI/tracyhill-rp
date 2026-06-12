# Slice 5 Increment: Session Export

## Scope
This is the second completed increment inside Slice 5, not the full slice.

Implemented here:
- typed session-export contract on the chat domain
- authenticated `/api/chat/sessions/:id/export` route
- server-side markdown formatting for session exports
- export coverage for text attachments, binary attachment markers, and generated-image markers
- active-session "Export Markdown" action in the web conversation pane
- browser download coverage for the export flow

## Notes
- export is currently markdown-only
- text attachments are embedded directly in fenced blocks
- binary attachments and generated images are represented as readable markdown markers rather than inline binary payloads

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`
