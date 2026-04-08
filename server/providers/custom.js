// ═══════════════════════════════════════════════════════════
// CUSTOM ENDPOINT PROVIDER — OpenAI-compatible Chat Completions (non-streaming)
// For use in pipeline/wizard with user-defined custom endpoints.
// ═══════════════════════════════════════════════════════════

import https from "https";
import http from "http";
import { trackRequest } from "./base.js";

/**
 * Non-streaming POST to a custom OpenAI-compatible endpoint.
 * Uses Chat Completions format (/chat/completions).
 *
 * @param {object} endpointConfig - { baseUrl, apiKey, authHeader, apiFormat }
 * @param {string} model - The actual model ID to send in the request body
 * @param {Array} messages - [{role, content}]
 * @param {number} maxTokens - Max output tokens
 * @param {number} temperature - Temperature (default 0)
 * @param {string|null} pipelineId - For request tracking/cancellation
 * @param {number} timeoutMs - Request timeout in ms
 */
export function customPost(endpointConfig, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(endpointConfig.baseUrl); } catch { return reject(new Error("Invalid custom endpoint base URL")); }

    const protocol = parsed.protocol === "http:" ? "http" : "https";
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port) || (protocol === "https" ? 443 : 80);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    const apiPath = basePath + "/chat/completions";

    const reqBody = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature,
      stream: false
    };

    const body = JSON.stringify(reqBody);
    const hdrs = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    };
    if (endpointConfig.authHeader === "Bearer" && endpointConfig.apiKey) {
      hdrs["Authorization"] = `Bearer ${endpointConfig.apiKey}`;
    } else if (endpointConfig.authHeader === "api-key" && endpointConfig.apiKey) {
      hdrs["api-key"] = endpointConfig.apiKey;
    }

    const mod = protocol === "http" ? http : https;
    const req = mod.request({ hostname, port, path: apiPath, method: "POST", headers: hdrs }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const data = JSON.parse(raw);
          resolve({ status: res.statusCode, data });
        } catch {
          resolve({ status: res.statusCode, data: { error: { message: raw.slice(0, 500) } } });
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Custom endpoint request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// Standard Chat Completions response extractors
export function extractText(data) {
  return data?.choices?.[0]?.message?.content || "";
}

export function isTruncated(data) {
  return data?.choices?.[0]?.finish_reason === "length";
}

export function extractUsage(data) {
  if (!data?.usage) return null;
  return {
    input_tokens: data.usage.prompt_tokens || 0,
    output_tokens: data.usage.completion_tokens || 0
  };
}
