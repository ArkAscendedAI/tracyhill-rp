// ═══════════════════════════════════════════════════════════
// XAI PROVIDER — Grok 4 via Chat Completions API (non-streaming)
// ═══════════════════════════════════════════════════════════

import https from "https";
import { trackRequest } from "./base.js";

export function xaiPost(apiKey, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    const reqBody = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature,
      stream: false
    };

    const body = JSON.stringify(reqBody);
    const req = https.request({
      hostname: "api.x.ai", port: 443, path: "/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`xAI API request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// Extract text from Chat Completions response
export function extractText(data) {
  return data?.choices?.[0]?.message?.content || "";
}

// Detect truncation
export function isTruncated(data) {
  return data?.choices?.[0]?.finish_reason === "length";
}

// Extract usage
export function extractUsage(data) {
  if (!data?.usage) return null;
  return {
    input_tokens: data.usage.prompt_tokens || 0,
    output_tokens: data.usage.completion_tokens || 0
  };
}
