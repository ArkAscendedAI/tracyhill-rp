// ═══════════════════════════════════════════════════════════
// PROVIDER REGISTRY — Model→provider mapping and unified callModel()
// ═══════════════════════════════════════════════════════════
//
// Central dispatch for all non-Anthropic pipeline API calls.
// Each model maps to a provider with its own API helper,
// text extractor, truncation detector, and usage normalizer.

import { loadUserKeys } from "../shared.js";
import { openaiPost, extractText as openaiText, isTruncated as openaiTrunc, extractUsage as openaiUsage } from "./openai.js";
import { xaiPost, extractText as xaiText, isTruncated as xaiTrunc, extractUsage as xaiUsage } from "./xai.js";
import { googlePost, extractText as googleText, isTruncated as googleTrunc, extractUsage as googleUsage } from "./google.js";
import { zaiPost, extractText as zaiText, isTruncated as zaiTrunc, extractUsage as zaiUsage } from "./zai.js";
import { deepseekPost, extractText as dsText, isTruncated as dsTrunc, extractUsage as dsUsage } from "./deepseek.js";
import { customPost, extractText as customText, isTruncated as customTrunc, extractUsage as customUsage } from "./custom.js";
import { RETRYABLE_STATUS } from "./base.js";

// ── Flagship models supported for pipeline/wizard ──
const MODEL_REGISTRY = {
  // OpenAI — Responses API, reasoning model
  "gpt-5.4":                { provider: "openai",  maxOut: 128000, keyField: "openai",  post: openaiPost,  extract: openaiText,  truncated: openaiTrunc,  usage: openaiUsage },
  // xAI — Chat Completions
  "grok-4":                 { provider: "xai",     maxOut: 131072, keyField: "xai",     post: xaiPost,     extract: xaiText,     truncated: xaiTrunc,     usage: xaiUsage },
  // Google — Gemini API
  "gemini-3.1-pro-preview": { provider: "google",  maxOut: 65536,  keyField: "google",  post: googlePost,  extract: googleText,  truncated: googleTrunc,  usage: googleUsage },
  // DeepSeek — Chat Completions with reasoning
  "deepseek-chat":          { provider: "deepseek", maxOut: 8192,  keyField: "deepseek", post: deepseekPost, extract: dsText, truncated: dsTrunc, usage: dsUsage },
  "deepseek-reasoner":      { provider: "deepseek", maxOut: 64000, keyField: "deepseek", post: deepseekPost, extract: dsText, truncated: dsTrunc, usage: dsUsage },
  // z.ai — Chat Completions with thinking
  "glm-5":                  { provider: "zai",     maxOut: 128000, keyField: "zai",     post: zaiPost,     extract: zaiText,     truncated: zaiTrunc,     usage: zaiUsage },
};

// ── Public API ──

export function getModelInfo(modelId) {
  return MODEL_REGISTRY[modelId] || null;
}

export function getMaxOut(modelId) {
  return MODEL_REGISTRY[modelId]?.maxOut || 65536;
}

export function isMultiModel(modelId) {
  return !!MODEL_REGISTRY[modelId];
}

export function isAnthropicModel(modelId) {
  return modelId?.startsWith("claude-");
}

export function isCustomModel(modelId) {
  return modelId?.startsWith("custom:");
}

/**
 * Parse a custom model ID: "custom:ep_abc123:model-name"
 * @returns {{ endpointId: string, actualModelId: string } | null}
 */
export function parseCustomModelId(modelId) {
  if (!modelId?.startsWith("custom:")) return null;
  const parts = modelId.split(":");
  if (parts.length < 3) return null;
  return { endpointId: parts[1], actualModelId: parts.slice(2).join(":") };
}

/**
 * Get maxOut for a custom model from user's endpoint config.
 */
export function getCustomMaxOut(userId, modelId) {
  const parsed = parseCustomModelId(modelId);
  if (!parsed) return 4096;
  const keys = loadUserKeys(userId);
  const ep = (keys.customEndpoints || []).find(e => e.id === parsed.endpointId);
  if (!ep) return 4096;
  const model = (ep.models || []).find(m => m.id === parsed.actualModelId);
  return model?.maxOut || 4096;
}

/**
 * Call a custom endpoint model (non-streaming, for pipeline/wizard).
 * Same normalized return as callModel(): { status, text, truncated, usage }
 */
export async function callCustomModel(userId, modelId, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  const parsed = parseCustomModelId(modelId);
  if (!parsed) throw new Error(`Invalid custom model ID: "${modelId}"`);

  const keys = loadUserKeys(userId);
  const ep = (keys.customEndpoints || []).find(e => e.id === parsed.endpointId);
  if (!ep) throw new Error(`Custom endpoint "${parsed.endpointId}" not found. Configure it in Settings.`);
  if (ep.authHeader !== "none" && !ep.apiKey) throw new Error(`No API key configured for custom endpoint "${ep.name}". Add one in Settings.`);

  const r = await customPost(ep, parsed.actualModelId, messages, maxTokens, temperature, pipelineId, timeoutMs);

  if (RETRYABLE_STATUS(r.status)) {
    return { retryableStatus: r.status, status: r.status, text: "", truncated: false, usage: null };
  }

  if (r.status !== 200) {
    const errMsg = r.data?.error?.message || (typeof r.data?.error === "string" ? r.data.error : null) || `API error ${r.status}`;
    throw new Error(`Custom endpoint "${ep.name}" API error (${r.status}): ${errMsg}`);
  }

  return {
    status: r.status,
    text: customText(r.data),
    truncated: customTrunc(r.data),
    usage: customUsage(r.data),
  };
}

/**
 * Unified model call — returns normalized { status, text, truncated, usage }
 *
 * @param {string} userId - For loading API keys
 * @param {string} model - Model ID (e.g., "gpt-5.4")
 * @param {Array} messages - [{role, content}] array
 * @param {number} maxTokens - Max output tokens
 * @param {number} temperature - Temperature (default 0)
 * @param {string|null} pipelineId - For request tracking/cancellation
 * @param {number} timeoutMs - Request timeout in ms
 * @returns {{ status: number, text: string, truncated: boolean, usage: object|null, retryableStatus?: number }}
 */
export async function callModel(userId, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  const info = MODEL_REGISTRY[model];
  if (!info) throw new Error(`Model "${model}" is not registered for pipeline use`);

  const keys = loadUserKeys(userId);
  const apiKey = keys[info.keyField];
  if (!apiKey) throw new Error(`No ${info.provider} API key configured. Add one in Settings.`);

  const r = await info.post(apiKey, model, messages, maxTokens, temperature, pipelineId, timeoutMs);

  // Check for retryable HTTP status
  if (RETRYABLE_STATUS(r.status)) {
    return { retryableStatus: r.status, status: r.status, text: "", truncated: false, usage: null };
  }

  // Check for API error
  if (r.status !== 200) {
    const errMsg = r.data?.error?.message || (typeof r.data?.error === "string" ? r.data.error : null) || `API error ${r.status}`;
    throw new Error(`${info.provider} API error (${r.status}): ${errMsg}`);
  }

  return {
    status: r.status,
    text: info.extract(r.data),
    truncated: info.truncated(r.data),
    usage: info.usage(r.data),
  };
}
