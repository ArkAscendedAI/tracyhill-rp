// ═══════════════════════════════════════════════════════════
// PROVIDER BASE — Shared infrastructure for multi-model pipeline
// ═══════════════════════════════════════════════════════════
//
// Retry logic, request tracking, and utilities shared by all
// non-Anthropic provider modules. Mirrors the patterns in the
// frozen pipeline.js/wizard.js but completely independent.

import { savePipeline } from "../shared.js";

// ── Active request tracking (for cancellation) ──
const activeRequests = new Map(); // pipelineId → [http.ClientRequest, ...]

export function trackRequest(pipelineId, req) {
  if (!pipelineId) return;
  if (!activeRequests.has(pipelineId)) activeRequests.set(pipelineId, []);
  activeRequests.get(pipelineId).push(req);
}

export function cancelRequests(pipelineId) {
  const reqs = activeRequests.get(pipelineId);
  if (reqs) { for (const r of reqs) { try { r.destroy(); } catch {} } activeRequests.delete(pipelineId); }
}

export function clearTracked(pipelineId) { activeRequests.delete(pipelineId); }

// ── Retry logic ──
export const RETRYABLE = (err) => err.message?.includes("timeout") || err.message?.includes("ECONNRESET") || err.message?.includes("socket hang up");
export const RETRYABLE_STATUS = (status) => [429, 500, 502, 503, 529].includes(status);
export const MAX_RETRIES = 2;
export const RETRY_DELAYS = [15000, 30000]; // 15s, 30s

export async function withRetry(fn, stepName, pipeline, userId) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fn();
      if (r?.retryableStatus && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 30000;
        console.log(`Pipeline ${pipeline.id} ${stepName}: retryable status ${r.retryableStatus}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
        if (pipeline[stepName]) { pipeline[stepName].retries = (pipeline[stepName].retries || 0) + 1; savePipeline(userId, pipeline); }
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return r;
    } catch (e) {
      if (RETRYABLE(e) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 30000;
        console.log(`Pipeline ${pipeline.id} ${stepName}: ${e.message}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
        if (pipeline[stepName]) { pipeline[stepName].retries = (pipeline[stepName].retries || 0) + 1; savePipeline(userId, pipeline); }
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw e;
    }
  }
}
