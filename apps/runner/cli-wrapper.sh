#!/bin/bash
# Launches the Claude Code binary bundled with the Agent SDK through `cat`.
# Kept from an earlier agent service: when the SDK writes a stream-json user
# message of ~146 KB or more straight into the CLI's stdin pipe, the CLI's
# input parser fails ("Error parsing streaming input line") and exits 1.
# Any buffered process in between re-chunks the write and the CLI parses it.
# The SDK is pointed here through options.pathToClaudeCodeExecutable.
set -euo pipefail
SDK_BASE="$(cd "$(dirname "$0")" && pwd)/node_modules/@anthropic-ai"
for variant in claude-agent-sdk-linux-x64 claude-agent-sdk-linux-x64-musl claude-agent-sdk-linux-arm64 claude-agent-sdk-linux-arm64-musl claude-agent-sdk-darwin-arm64 claude-agent-sdk-darwin-x64; do
  candidate="$SDK_BASE/$variant/claude"
  if [ -x "$candidate" ]; then CLAUDE="$candidate"; break; fi
done
if [ -z "${CLAUDE:-}" ]; then echo "cli-wrapper.sh: no claude binary found under $SDK_BASE/" >&2; exit 127; fi
exec cat | "$CLAUDE" "$@"
