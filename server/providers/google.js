// ═══════════════════════════════════════════════════════════
// GOOGLE PROVIDER — Gemini 3.1 Pro via generateContent (non-streaming)
// ═══════════════════════════════════════════════════════════

import https from "https";
import { trackRequest } from "./base.js";

export function googlePost(apiKey, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    // Convert messages to Gemini format
    // Pipeline always sends a single user message — map directly
    const contents = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: m.content }] });
    }

    const reqBody = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        thinkingConfig: {
          thinkingBudget: 32768 // Maximum thinking for pipeline quality
        }
      }
    };

    const body = JSON.stringify(reqBody);
    const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const req = https.request({
      hostname: "generativelanguage.googleapis.com", port: 443, path, method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Google API request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// Extract text from Gemini response
export function extractText(data) {
  if (!data?.candidates?.[0]?.content?.parts) return "";
  return data.candidates[0].content.parts
    .filter(p => p.text !== undefined)
    .map(p => p.text)
    .join("");
}

// Detect truncation
export function isTruncated(data) {
  return data?.candidates?.[0]?.finishReason === "MAX_TOKENS";
}

// Extract usage
export function extractUsage(data) {
  if (!data?.usageMetadata) return null;
  return {
    input_tokens: data.usageMetadata.promptTokenCount || 0,
    output_tokens: data.usageMetadata.candidatesTokenCount || 0
  };
}
