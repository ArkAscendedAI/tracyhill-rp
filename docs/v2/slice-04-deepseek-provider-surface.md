# Slice 4 Parity Follow-up: DeepSeek Provider Surface

## Goal
- close the newly exposed Slice 4 gap where current `v1` still shipped built-in DeepSeek chat support but `v2` had no DeepSeek provider surface at all

## `v1` Oracle
- current `v1` exposes two built-in DeepSeek chat models:
  - `deepseek-chat`
  - `deepseek-reasoner`
- current `v1` stores a dedicated DeepSeek API key alongside the other built-in provider keys
- current `v1` routes DeepSeek through its own chat-completions path with `stream_options.include_usage`, model-specific `max_tokens`, and text-only message shaping:
  - system prompt joins campaign prompt plus seed with `\n\n---\n\n`
  - text-file attachments are preserved as `<attached_file ...>` blocks
  - binary/image/PDF attachments are not lifted into native multimodal payloads on that path
  - consecutive same-role turns still coalesce when the content stays plain text
  - current built-in DeepSeek models land on `temperature = 1`

## Implemented In `v2`
- expanded the shared provider-key contract/status map to include `deepseek`
- expanded the shared model catalog to restore the current built-in DeepSeek model surface with matching labels, max-output values, and pricing metadata
- added a dedicated built-in DeepSeek runtime to `packages/provider-runtime` instead of forcing DeepSeek through another provider abstraction
- restored the current `v1` DeepSeek request shape:
  - `POST https://api.deepseek.com/chat/completions`
  - `stream: true`
  - `stream_options: { include_usage: true }`
  - `max_tokens` from the shared model catalog
  - forced `temperature = 1` on the current built-in DeepSeek models
  - plain-text message shaping with text-attachment blocks and same-role text coalescing
- wired DeepSeek into:
  - API env/runtime defaults
  - per-user provider-key fallback resolution
  - provider-keys dialog/status surface
  - model picker/provider labeling in chat
  - worker runtime default plumbing

## Hidden Gap Found During Re-audit
- this was not a minor request-shape mismatch; the re-audit showed a real missing built-in provider:
  - `v1` still had DeepSeek models, key storage, pricing, billing links, and `/api/proxy/deepseek`
  - `v2` had no DeepSeek provider enum entry, no model-catalog entries, no key-status handling, and no runtime path
- the same re-audit also confirmed the DeepSeek path is intentionally text-only in the current `v1` surface, so parity required a dedicated runtime instead of reusing the richer OpenAI-compatible multimodal builder

## Verification
- `npm test --workspace @tracyhill-rp/provider-runtime`
- `npm test --workspace @tracyhill-rp/api -- providerKeyRoutes.test.ts providerKeyRuntime.test.ts workspaceRoutes.test.ts chatRoutes.test.ts`
- `npm run typecheck`
- `npm run build`

## Remaining Slice 4 Gap
- the built-in DeepSeek provider surface is now restored inside the audited scope
- no further confirmed Slice 4 product-behavior gaps remain in the audited scope after this follow-up
