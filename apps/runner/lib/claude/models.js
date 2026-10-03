// Permissive: accept any claude-* model and pass through to the SDK. The SDK
// (and Anthropic upstream) does the real validation.
const ADVERTISED = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const ALIASES = {
  "claude-fable-5-1-latest": "claude-fable-5-1",
  "claude-fable-5-latest": "claude-fable-5",
  "claude-opus-5-5-latest": "claude-opus-5-5",
  "claude-opus-5-latest": "claude-opus-5",
  "claude-sonnet-5-5-latest": "claude-sonnet-5-5",
  "claude-sonnet-5-latest": "claude-sonnet-5",
  "claude-opus-4-8-latest": "claude-opus-4-8",
  "claude-opus-4-7-latest": "claude-opus-4-7",
  "claude-opus-4-6-latest": "claude-opus-4-6",
  "claude-sonnet-4-6-latest": "claude-sonnet-4-6",
  "claude-haiku-4-5-latest": "claude-haiku-4-5",
};

const DEFAULT_MODEL = "claude-opus-4-7";

export function resolveModel(input) {
  if (!input) return DEFAULT_MODEL;
  const trimmed = String(input).trim();
  const aliased = ALIASES[trimmed] || trimmed;
  if (aliased.startsWith("claude-")) return aliased;
  console.error(`[runner] non-claude model "${input}", coercing to ${DEFAULT_MODEL}`);
  return DEFAULT_MODEL;
}

export function listModels() {
  return [...ADVERTISED];
}
