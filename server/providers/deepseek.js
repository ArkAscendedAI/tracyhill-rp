// ═══════════════════════════════════════════════════════════
// DEEPSEEK PROVIDER — DeepSeek V3/R1 via Chat Completions API (non-streaming)
// ═══════════════════════════════════════════════════════════

import https from "https";
import { trackRequest } from "./base.js";

export function deepseekPost(apiKey, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    // Strip reasoning_content from assistant messages — DeepSeek returns 400 if present
    const cleanMsgs = messages.map(m => m.role === "assistant" ? { role: m.role, content: m.content } : { role: m.role, content: m.content });
    const reqBody = {
      model,
      messages: cleanMsgs,
      max_tokens: maxTokens,
      stream: false
    };
    // deepseek-reasoner ignores temperature; deepseek-chat with thinking needs temp 1
    if (model === "deepseek-reasoner") { /* temperature not sent — ignored anyway */ }
    else reqBody.temperature = temperature;

    const body = JSON.stringify(reqBody);
    const req = https.request({
      hostname: "api.deepseek.com", port: 443, path: "/chat/completions", method: "POST",
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`DeepSeek API request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

export function extractText(data) {
  return data?.choices?.[0]?.message?.content || "";
}

export function isTruncated(data) {
  const reason = data?.choices?.[0]?.finish_reason;
  return reason === "length" || reason === "insufficient_system_resource";
}

export function extractUsage(data) {
  if (!data?.usage) return null;
  return {
    input_tokens: data.usage.prompt_tokens || 0,
    output_tokens: data.usage.completion_tokens || 0
  };
}
