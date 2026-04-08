// ═══════════════════════════════════════════════════════════
// OPENAI PROVIDER — GPT-5.4 via Responses API (non-streaming)
// ═══════════════════════════════════════════════════════════

import https from "https";
import { trackRequest } from "./base.js";

// GPT-5.4 is a reasoning model — uses the Responses API with reasoning effort
export function openaiPost(apiKey, model, messages, maxTokens, temperature = 1, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    // Build input array from messages (Responses API format)
    const input = [];
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant") {
        input.push({ role: m.role, content: m.content });
      }
    }

    const reqBody = {
      model,
      input,
      reasoning: { effort: "high" },
      max_output_tokens: maxTokens,
      stream: false
    };
    // Reasoning models ignore temperature — always 1

    const body = JSON.stringify(reqBody);
    const req = https.request({
      hostname: "api.openai.com", port: 443, path: "/v1/responses", method: "POST",
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`OpenAI API request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// Extract text from Responses API response
export function extractText(data) {
  if (!data?.output) return "";
  const texts = [];
  for (const block of data.output) {
    if (block.type === "message" && block.content) {
      for (const part of block.content) {
        if (part.type === "output_text") texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

// Detect truncation
export function isTruncated(data) {
  return data?.status === "incomplete" || data?.incomplete_details?.reason === "max_output_tokens";
}

// Extract usage
export function extractUsage(data) {
  if (!data?.usage) return null;
  return {
    input_tokens: data.usage.input_tokens || 0,
    output_tokens: data.usage.output_tokens || 0
  };
}
