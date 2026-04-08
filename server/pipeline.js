// ═══════════════════════════════════════════════════════════
// UPDATE PIPELINE — Automated state seed generation, validation, system prompt diff
// ═══════════════════════════════════════════════════════════

import { Router } from "express";
import crypto from "crypto";
import https from "https";
import { requireAuth, loadCampaigns, saveCampaigns, loadUserKeys, loadUserState, saveUserState, savePipeline, loadPipeline, pipelinesDir, archiveCampaignVersion, loadSession, saveSession, isMigrated, updateSessionMeta, buildSessionMeta, loadUserMeta, saveUserMeta, loadSessionsMeta } from "./shared.js";
import { readdirSync, existsSync } from "fs";

const router = Router();

// ── Extract cold start section from state seed ──
function extractColdStart(seed) {
  if (!seed) return null;
  // Match common cold start header patterns (case-insensitive)
  const headerPattern = /^(#{1,3})\s*(?:(?:section\s+\w+\s*[—–-]\s*)?(?:cold\s*start|orientation|cold\s*start\s*[\/&]\s*orientation|session\s*start))\b[^\n]*/im;
  const match = seed.match(headerPattern);
  if (!match) return null;
  const headerLevel = match[1].length; // number of #'s
  const startIdx = match.index;
  // Find the next header at same or higher level
  const rest = seed.slice(startIdx + match[0].length);
  const nextHeader = rest.match(new RegExp(`^#{1,${headerLevel}}\\s`, "m"));
  const content = nextHeader ? rest.slice(0, nextHeader.index).trim() : rest.trim();
  const full = match[0] + "\n" + content;
  return full.trim() || null;
}

// Model output limits (subset relevant for pipeline — sync with frontend MODELS if needed)
const MODEL_MAX_OUT = {
  "claude-opus-4-6": 128000, "claude-sonnet-4-6": 64000, "claude-sonnet-4": 64000, "claude-haiku-4.5": 64000,
};
function getMaxOut(modelId) { return MODEL_MAX_OUT[modelId] || 64000; }

// ── Active request tracking (for cancellation) ──
const activeRequests = new Map(); // pipelineId → [http.ClientRequest, ...]
function trackRequest(pipelineId, req) { if (!activeRequests.has(pipelineId)) activeRequests.set(pipelineId, []); activeRequests.get(pipelineId).push(req); }
function cancelRequests(pipelineId) { const reqs = activeRequests.get(pipelineId) || []; for (const r of reqs) { try { r.destroy(new Error("Pipeline cancelled")); } catch {} } activeRequests.delete(pipelineId); }
function clearTracked(pipelineId) { activeRequests.delete(pipelineId); }

// ── Orphan cleanup — call from server.js on startup ──
export function cleanOrphanedPipelines(usersDir) {
  if (!existsSync(usersDir)) return;
  for (const userId of readdirSync(usersDir)) {
    const pipDir = `${usersDir}/${userId}/pipelines`;
    if (!existsSync(pipDir)) continue;
    for (const f of readdirSync(pipDir).filter(f => f.endsWith(".json"))) {
      try {
        const p = loadPipeline(userId, f.replace(".json", ""));
        if (p && ["running", "running_step1", "running_step2", "running_step3"].includes(p.status)) {
          p.status = "failed";
          p.error = "Pipeline interrupted (server restart)";
          p.completedAt = new Date().toISOString();
          for (const key of ["step1", "step2", "step3"]) {
            if (p[key]?.status === "running") { p[key].status = "failed"; p[key].error = "Interrupted (server restart)"; }
            if (p[key]?.autoFixStatus === "running") { p[key].autoFixStatus = "failed"; p[key].autoFixError = "Interrupted (server restart)"; }
            if (p[key]?.fixApplyStatus === "running") { p[key].fixApplyStatus = "failed"; p[key].fixApplyError = "Interrupted (server restart)"; }
            if (p[key]?.applyStatus === "running") { p[key].applyStatus = "failed"; p[key].applyError = "Interrupted (server restart)"; }
          }
          savePipeline(userId, p);
          console.log(`Cleaned orphaned pipeline ${p.id} for user ${userId}`);
        }
      } catch {}
    }
  }
}

// ── Validation prompt (hardcoded) ──
const VALIDATION_PROMPT = `You are a quality assurance auditor for a collaborative fiction state management system. You are NOT a roleplay partner. Do not write fiction.

I will provide you with:
1. A NEWLY GENERATED state seed (the document being audited)
2. The SESSION TRANSCRIPT it was generated from
3. The SYSTEM PROMPT for reference

Your task: Audit the new state seed for the following specific failure modes. For each category, report PASS or FAIL with specific evidence.

## AUDIT CATEGORIES

### 1. SELF-CONTAINMENT
Search the entire document for any of these patterns:
- "Same as v[any number]"
- "Unchanged from v[any number]"
- "Everything from v[any number]"
- "As in previous seed"
- "See prior version"
- Any reference to a document version that is not the current one
- Any phrase that defers content to a document not present in the seed itself
- Any Knows/Doesn't Know list that says "unchanged" or "same as before" instead of listing actual content

Report: PASS (no cross-version references found) or FAIL (list every instance with its location in the document).

### 2. INFORMATION BOUNDARIES
Select THREE characters from the information boundaries section. For each:
- Pick one fact from their Knows list that was added this session
- Verify against the transcript: was this character physically present when this information was revealed or explicitly told on-screen?
- Pick one fact from their Doesn't Know list
- Verify it wasn't accidentally revealed to them in the transcript

Report: PASS/FAIL per character with evidence.

### 3. SECTION STRUCTURE
Verify:
- A cold start / orientation section exists and contains: exact in-world date, current location, immediate situation
- An active state section contains the most recent sessions at appropriate detail levels
- The newest session is at full detail in the active state section
- The compression cascade is correct (detail reduces as sessions age)
- An end state / session end section exists with a character position table

Report: PASS/FAIL per structural element.

### 4. TRANSCRIPT COVERAGE
Identify the THREE most significant events/revelations/decisions from the transcript. Verify each one appears in the new state seed at appropriate detail level. Check that none were silently dropped.

Report: PASS/FAIL per event with location in seed where it appears (or note its absence).

### 5. THREAD INTEGRITY
If the seed uses a thread/countdown system:
- Verify no active thread from the transcript was silently dropped
- Verify resolved threads were removed (not left as stubs)
- Verify any operational threads have anchors with appropriate tracking tags

Report: PASS/FAIL with specifics.

### 6. OUTPUT COMPLETENESS
- Was the document truncated? (Look for abrupt endings, incomplete sections, missing closing markers)
- Are all sections present that should be?

Report: PASS/FAIL.

## OUTPUT FORMAT

Start with a single summary line:
**VALIDATION: PASS** (all categories passed) or **VALIDATION: FAIL** (list failing categories)

Then provide the detailed report for each category. Be specific — quote document locations and transcript evidence. Do not hedge or be vague. If something fails, say exactly what failed and where.`;

// ── Auto-fix prompt (hardcoded) — runs when validation fails ──
const FIX_PROMPT = `You are a document editor. A state seed was generated and failed quality validation. Your job is to produce SURGICAL EDITS that fix ONLY the specific issues identified in the validation report. Do not touch anything that was not flagged.

Reference materials (session transcript, previous state seed, system prompt) are provided so you can look up correct information when fixing issues — for example, expanding a lazy "Same as X" shorthand into the actual content that should be there.

Output your fixes using this format:
- "REPLACE in [section heading or description]: [exact old text] → [corrected new text]"
- "ADD to [section heading or description], after [exact preceding text]: [text to insert]"
- "DELETE from [section heading or description]: [exact text to remove]"

For each edit, quote enough surrounding context in the old text to make the location unambiguous. If a section needs substantial rewriting (e.g., an entire Knows/Doesn't Know list was lazy-referenced), quote the full lazy block as old text and provide the full replacement.

Do not output the complete document. Do not add commentary or explanation — output only the surgical edits.`;

// ── Fix-apply prompt (hardcoded) — applies surgical fix edits to the state seed ──
const FIX_APPLY_PROMPT = `You are a document editor. Apply the provided surgical edits to the state seed document. The edits use formats like:
- "REPLACE in [section]: [old text] → [new text]"
- "ADD to [section], after [existing text]: [text to insert]"
- "DELETE from [section]: [text to remove]"

Reference materials (session transcript, previous state seed, system prompt) are provided for context if needed.

Apply every edit precisely. Do not make any other changes to the document. Do not add commentary or explanation — output only the complete updated state seed.`;

// ── Apply-diffs prompt (hardcoded) — runs when Step 3 recommends changes ──
const APPLY_DIFFS_PROMPT = `You are a document editor. Apply the provided surgical edits to the system prompt document. The edits use formats like:
- "ADD to [section], after [existing text]:" followed by text to insert
- "REPLACE in [section]: [old text] → [new text]"
- "DELETE from [section]: [text to remove]"

Reference materials (session transcript, previous state seed) are provided for context if needed.

Apply every recommended edit precisely. Do not make any other changes to the document. Do not add commentary or explanation — output only the complete updated system prompt.`;

// ── Anthropic API helper (non-streaming, cancellable, configurable timeout) ──
function anthropicPost(apiKey, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: maxTokens, temperature, messages });
    const req = https.request({
      hostname: "api.anthropic.com", port: 443, path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01",
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Pipeline API request timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// ── Retry wrapper — retries transient failures (timeout, 529 overloaded, 500 server error) ──
const RETRYABLE = (err) => err.message?.includes("timeout") || err.message?.includes("ECONNRESET") || err.message?.includes("socket hang up");
const RETRYABLE_STATUS = (status) => [429, 500, 502, 503, 529].includes(status);
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15000, 30000]; // 15s, 30s

async function withRetry(fn, stepName, pipeline, userId) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fn();
      // Check for retryable HTTP status (fn resolves with status for API errors)
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

// ── Extract text content from Anthropic response ──
function extractText(data) {
  if (!data?.content) return "";
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

// ── Export transcript from session (server-side, mirrors frontend exportSession) ──
function exportTranscript(session) {
  const META_PREFIXES = ["**Credit Balance Error:**", "**API Error:**", "**Network Error:**", "**Authentication Error:**", "*[Stopped before response began]*", "*[Response contained only thinking"];
  let md = `# ${session.name}\n\n`;
  for (const m of (session.messages || [])) {
    if (META_PREFIXES.some(p => m.content?.startsWith(p))) continue;
    const clean = (m.content || "").replace(/\n\n\*\[Stopped\]\*$/, "").replace(/\n\n---\n\n\*\[Stream interrupted:.*?\]\*$/, "");
    if (!clean.trim()) continue;
    md += `### ${m.role === "user" ? "User" : "Assistant"}\n\n${clean}\n\n`;
  }
  return md;
}

// ═══════════════════════════════════════════════════════════
// PIPELINE EXECUTION (async, runs server-side)
// ═══════════════════════════════════════════════════════════

// ── Individual step runners (used by both runPipeline and retry) ──

async function runStep1(apiKey, model, pipeline, pipelineId, userId) {
  const maxOut = getMaxOut(model);
  const userMsg = `${pipeline.updatePromptTemplate}

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>

<current_state_seed>
${pipeline.currentStateSeed}
</current_state_seed>

<session_transcript>
${pipeline.transcript}
</session_transcript>`;

  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: userMsg }], maxOut, 0, pipelineId, 2100000); // 35 min timeout
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step1", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);

  const fullText = extractText(r.data);
  const truncated = r.data?.stop_reason === "max_tokens";

  // Strip any leading assessment line the model might still produce (backward compat)
  const lines = fullText.split("\n");
  let seedStartIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (line.startsWith("SYSTEM_PROMPT") || (line.toLowerCase().includes("no changes") && !line.startsWith("#"))) {
      seedStartIdx = i + 1;
      while (seedStartIdx < lines.length && !lines[seedStartIdx].trim()) seedStartIdx++;
      break;
    }
  }

  return { result: lines.slice(seedStartIdx).join("\n").trim(), truncated, usage: r.data?.usage || null };
}

async function runStep2(apiKey, model, pipeline, pipelineId, userId) {
  const valMsg = `${VALIDATION_PROMPT}

<new_state_seed>
${pipeline.step1.result}
</new_state_seed>

<session_transcript>
${pipeline.transcript}
</session_transcript>

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>`;

  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: valMsg }], 16384, 0, pipelineId, 600000); // 10 min timeout
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  const valText = extractText(r.data);
  return { result: valText, passed: /\*\*VALIDATION:\s*PASS\*\*/i.test(valText), usage: r.data?.usage || null };
}

async function runStep3(apiKey, model, pipeline, pipelineId, userId) {
  if (!pipeline.systemPromptUpdateTemplate) return { result: "No system prompt update template configured", skipped: true };

  const sysMsg = `${pipeline.systemPromptUpdateTemplate}

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>

<session_transcript>
${pipeline.transcript}
</session_transcript>`;

  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: sysMsg }], 16384, 0, pipelineId, 600000); // 10 min timeout
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step3", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  return { result: extractText(r.data), usage: r.data?.usage || null };
}

async function runStep2Fix(apiKey, model, pipeline, pipelineId, userId) {
  const msg = `${FIX_PROMPT}

<validation_report>
${pipeline.step2.result}
</validation_report>

<generated_state_seed>
${pipeline.step1.result}
</generated_state_seed>

<session_transcript>
${pipeline.transcript}
</session_transcript>

<previous_state_seed>
${pipeline.currentStateSeed}
</previous_state_seed>

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>`;

  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: msg }], 16384, 0, pipelineId, 600000); // 10 min timeout — surgical edits only
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  return { result: extractText(r.data), usage: r.data?.usage || null };
}

async function runStep2FixApply(apiKey, model, pipeline, pipelineId, userId) {
  const msg = `${FIX_APPLY_PROMPT}

<surgical_edits>
${pipeline.step2.fixEdits}
</surgical_edits>

<generated_state_seed>
${pipeline.step1.result}
</generated_state_seed>

<session_transcript>
${pipeline.transcript}
</session_transcript>

<previous_state_seed>
${pipeline.currentStateSeed}
</previous_state_seed>

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>`;

  const maxOut = getMaxOut(model);
  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: msg }], maxOut, 0, pipelineId, 1200000); // 20 min timeout — full document output
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  return { result: extractText(r.data), usage: r.data?.usage || null };
}

async function runStep3Apply(apiKey, model, pipeline, pipelineId, userId) {
  const msg = `${APPLY_DIFFS_PROMPT}

<surgical_edits>
${pipeline.step3.result}
</surgical_edits>

<system_prompt>
${pipeline.systemPrompt}
</system_prompt>

<session_transcript>
${pipeline.transcript}
</session_transcript>

<previous_state_seed>
${pipeline.currentStateSeed}
</previous_state_seed>`;

  const maxOut = getMaxOut(model);
  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: msg }], maxOut, 0, pipelineId, 1200000); // 20 min timeout
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, "step3", pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  return { result: extractText(r.data), usage: r.data?.usage || null };
}

// ── Main pipeline orchestrator ──

async function runPipeline(userId, pipeline) {
  const keys = loadUserKeys(userId);
  const apiKey = keys.anthropic;
  if (!apiKey) { pipeline.status = "failed"; pipeline.error = "No Anthropic API key configured"; savePipeline(userId, pipeline); return; }

  const model = pipeline.model;

  // ── Step 1 (seed generation) and Step 3 (system prompt assessment) run in PARALLEL ──
  pipeline.step1.status = "running";
  pipeline.step1.startedAt = new Date().toISOString();
  pipeline.step3.status = pipeline.systemPromptUpdateTemplate ? "running" : "skipped";
  if (pipeline.step3.status === "running") pipeline.step3.startedAt = new Date().toISOString();
  pipeline.status = "running";
  savePipeline(userId, pipeline);

  const step1Promise = runStep1(apiKey, model, pipeline, pipeline.id, userId).then(r => {
    pipeline.step1.status = "complete";
    pipeline.step1.completedAt = new Date().toISOString();
    pipeline.step1.result = r.result;
    pipeline.step1.truncated = r.truncated;
    pipeline.step1.usage = r.usage;
    savePipeline(userId, pipeline);
    return r;
  }).catch(e => {
    pipeline.step1.status = "failed";
    pipeline.step1.error = e.message;
    savePipeline(userId, pipeline);
    throw e;
  });

  const step3Promise = pipeline.systemPromptUpdateTemplate ? runStep3(apiKey, model, pipeline, pipeline.id, userId).then(async (r) => {
    if (r.skipped) { pipeline.step3.status = "skipped"; pipeline.step3.result = r.result; }
    else { pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString(); pipeline.step3.result = r.result; pipeline.step3.usage = r.usage; }
    savePipeline(userId, pipeline);
    // Step 3.5: If changes recommended, apply them to produce the updated system prompt
    const hasChanges = r.result && !r.skipped && !/no changes needed/i.test(r.result);
    if (hasChanges) {
      pipeline.step3.applyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep3Apply(apiKey, model, pipeline, pipeline.id, userId);
        pipeline.step3.applyStatus = "complete";
        pipeline.step3.appliedResult = applyResult.result;
        pipeline.step3.applyUsage = applyResult.usage;
        savePipeline(userId, pipeline);
      } catch (e) {
        pipeline.step3.applyStatus = "failed";
        pipeline.step3.applyError = e.message;
        savePipeline(userId, pipeline);
        // Non-fatal — user can review diffs manually
      }
    }
  }).catch(e => {
    pipeline.step3.status = "failed";
    pipeline.step3.error = e.message;
    savePipeline(userId, pipeline);
    // Step 3 failure is non-fatal
  }) : Promise.resolve().then(() => { pipeline.step3.status = "skipped"; pipeline.step3.result = "No system prompt update template configured"; savePipeline(userId, pipeline); });

  // Wait for Step 1 (required for Step 2). Step 3 runs alongside.
  try {
    await step1Promise;
  } catch (e) {
    // Step 1 failed — wait for Step 3 to finish, then mark pipeline failed
    await step3Promise.catch(() => {});
    pipeline.status = "failed";
    pipeline.error = `Seed generation failed: ${e.message}`;
    savePipeline(userId, pipeline);
    return;
  }

  // ── Step 2: Validation (sequential — needs Step 1 result) ──
  pipeline.step2.status = "running";
  pipeline.step2.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  try {
    const r = await runStep2(apiKey, model, pipeline, pipeline.id, userId);
    pipeline.step2.status = "complete";
    pipeline.step2.completedAt = new Date().toISOString();
    pipeline.step2.result = r.result;
    pipeline.step2.passed = r.passed;
    pipeline.step2.usage = r.usage;
    savePipeline(userId, pipeline);
  } catch (e) {
    pipeline.step2.status = "failed";
    pipeline.step2.error = e.message;
    savePipeline(userId, pipeline);
    // Validation failure is non-fatal
  }

  // Step 2.5: Auto-fix if validation failed with actionable issues (two-phase: surgical edits → apply)
  if (pipeline.step2.status === "complete" && !pipeline.step2.passed) {
    pipeline.step2.autoFixStatus = "running";
    savePipeline(userId, pipeline);
    try {
      const fixResult = await runStep2Fix(apiKey, model, pipeline, pipeline.id, userId);
      pipeline.step2.autoFixStatus = "complete";
      pipeline.step2.fixEdits = fixResult.result;
      pipeline.step2.fixUsage = fixResult.usage;
      savePipeline(userId, pipeline);
      console.log(`Pipeline ${pipeline.id} surgical fix edits generated`);

      // Step 2.5b: Apply the surgical edits to produce the corrected state seed
      pipeline.step2.fixApplyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep2FixApply(apiKey, model, pipeline, pipeline.id, userId);
        pipeline.step2.fixApplyStatus = "complete";
        pipeline.step2.fixedSeed = applyResult.result;
        pipeline.step2.fixApplyUsage = applyResult.usage;
        savePipeline(userId, pipeline);
        console.log(`Pipeline ${pipeline.id} surgical fix applied`);
      } catch (e) {
        pipeline.step2.fixApplyStatus = "failed";
        pipeline.step2.fixApplyError = e.message;
        savePipeline(userId, pipeline);
        // Non-fatal — user can review edits and apply manually
      }
    } catch (e) {
      pipeline.step2.autoFixStatus = "failed";
      pipeline.step2.autoFixError = e.message;
      savePipeline(userId, pipeline);
      // Non-fatal — user can still manually fix in the textarea
    }
  }

  // Wait for Step 3 + 3.5 to finish (may already be done)
  await step3Promise.catch(() => {});

  // ── Done ──
  clearTracked(pipeline.id);
  pipeline.status = "complete";
  pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
  console.log(`Pipeline ${pipeline.id} complete for campaign ${pipeline.campaignId} (v${pipeline.fromVersion} → v${pipeline.toVersion})`);
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── Start pipeline ──
router.post("/start", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { campaignId, sessionId } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const campaigns = loadCampaigns(userId);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (!campaign.updatePromptTemplate) return res.status(400).json({ error: "No update prompt template configured for this campaign" });
  if (!campaign.stateSeed) return res.status(400).json({ error: "No state seed configured for this campaign" });
  if (!campaign.systemPrompt) return res.status(400).json({ error: "No system prompt configured for this campaign" });

  // Check for already-running pipeline
  const dir = pipelinesDir(userId);
  const existing = readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const f of existing) {
    try {
      const p = loadPipeline(userId, f.replace(".json", ""));
      if (p && p.campaignId === campaignId && ["running", "running_step1", "running_step2", "running_step3"].includes(p.status)) {
        return res.status(409).json({ error: "A pipeline is already running for this campaign", pipelineId: p.id });
      }
    } catch {}
  }

  // Get session and export transcript
  const targetSessionId = sessionId || campaign.activeSessionId;
  let session;
  if (isMigrated(userId)) {
    session = loadSession(userId, targetSessionId);
  } else {
    const state = loadUserState(userId);
    if (!state) return res.status(400).json({ error: "No user state" });
    const sessions = state.sessions || {};
    session = typeof sessions === "object" && !Array.isArray(sessions) ? sessions[targetSessionId] : (Array.isArray(sessions) ? sessions.find(s => s.id === targetSessionId) : null);
  }
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.messages?.length) return res.status(400).json({ error: "Session has no messages" });

  const transcript = exportTranscript(session);

  // Auto-rename the session and move it into the campaign folder (archive)
  const partNum = (campaign.stateSeedVersion || 0) + 1;
  const dateStr = new Date().toISOString().slice(0, 10);
  session.name = `Part ${partNum} (${dateStr})`;
  if (campaign.folderId) session.folderId = campaign.folderId;
  if (isMigrated(userId)) {
    saveSession(userId, session);
    updateSessionMeta(userId, session.id, buildSessionMeta(session));
  } else {
    const state = loadUserState(userId);
    if (state) {
      const sessions = state.sessions || {};
      if (typeof sessions === "object" && !Array.isArray(sessions)) sessions[targetSessionId] = session;
      saveUserState(userId, state);
    }
  }

  // Create pipeline
  const pipeline = {
    id: crypto.randomBytes(12).toString("hex"),
    campaignId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    model: campaign.pipelineModel || "claude-opus-4-6",
    fromVersion: campaign.stateSeedVersion || 0,
    toVersion: partNum,
    sessionId: targetSessionId,
    sessionName: session.name,
    // Store documents needed for pipeline execution
    transcript,
    currentStateSeed: campaign.stateSeed,
    systemPrompt: campaign.systemPrompt,
    updatePromptTemplate: campaign.updatePromptTemplate,
    systemPromptUpdateTemplate: campaign.systemPromptUpdateTemplate || "",
    error: null,
    step1: { status: "pending", startedAt: null, completedAt: null, result: null, truncated: false, usage: null, error: null },
    step2: { status: "pending", startedAt: null, completedAt: null, result: null, passed: null, usage: null, error: null },
    step3: { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null }
  };

  savePipeline(userId, pipeline);
  res.json({ pipelineId: pipeline.id, status: pipeline.status });

  // Run async — don't await
  runPipeline(userId, pipeline).catch(e => {
    pipeline.status = "failed";
    pipeline.error = `Unexpected error: ${e.message}`;
    savePipeline(userId, pipeline);
    console.error(`Pipeline ${pipeline.id} unexpected error:`, e);
  });
});

// ── Poll status ──
router.get("/status/:id", requireAuth, (req, res) => {
  const pipeline = loadPipeline(req.session.userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  // Don't send the full documents in status polls — just metadata and results
  const { transcript, currentStateSeed, systemPrompt, updatePromptTemplate, systemPromptUpdateTemplate, ...meta } = pipeline;
  res.json(meta);
});

// ── Get full pipeline (including new seed text for review) ──
router.get("/full/:id", requireAuth, (req, res) => {
  const pipeline = loadPipeline(req.session.userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  // Send step results but not the input documents (they're large and client already has them)
  res.json({
    id: pipeline.id, campaignId: pipeline.campaignId, status: pipeline.status,
    startedAt: pipeline.startedAt, completedAt: pipeline.completedAt,
    model: pipeline.model, fromVersion: pipeline.fromVersion, toVersion: pipeline.toVersion,
    sessionId: pipeline.sessionId, sessionName: pipeline.sessionName,
    error: pipeline.error, step1: pipeline.step1, step2: pipeline.step2, step3: pipeline.step3
  });
});

// ── Check for active/complete/failed pipeline (most recent non-approved/rejected) ──
router.get("/active", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const dir = pipelinesDir(userId);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : [];

  for (const f of files.sort().reverse()) {
    try {
      const p = loadPipeline(userId, f.replace(".json", ""));
      if (p && ["running", "running_step1", "running_step2", "running_step3", "complete", "failed", "cancelled"].includes(p.status)) {
        return res.json({ active: true, pipelineId: p.id, status: p.status, campaignId: p.campaignId });
      }
    } catch {}
  }
  res.json({ active: false });
});

// ── Pipeline history for a campaign ──
router.get("/history/:campaignId", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const dir = pipelinesDir(userId);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : [];
  const pipelines = [];
  for (const f of files.sort().reverse()) {
    try {
      const p = loadPipeline(userId, f.replace(".json", ""));
      if (p && p.campaignId === req.params.campaignId) {
        pipelines.push({
          id: p.id, status: p.status, startedAt: p.startedAt, completedAt: p.completedAt,
          model: p.model, fromVersion: p.fromVersion, toVersion: p.toVersion,
          sessionName: p.sessionName, error: p.error,
          step1Status: p.step1?.status, step1Error: p.step1?.error, step1HasResult: !!p.step1?.result, step1Truncated: p.step1?.truncated,
          step2Status: p.step2?.status, step2Passed: p.step2?.passed, step2Error: p.step2?.error,
          step3Status: p.step3?.status, step3Error: p.step3?.error, step3HasResult: !!p.step3?.result
        });
      }
    } catch {}
  }
  res.json(pipelines);
});

// ── Approve pipeline results ──
router.post("/approve", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { pipelineId, approvedStateSeed, approvedSystemPrompt, startNewSession } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });

  const pipeline = loadPipeline(userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  if (pipeline.status !== "complete") return res.status(400).json({ error: "Pipeline not complete" });

  const campaigns = loadCampaigns(userId);
  const cidx = campaigns.findIndex(c => c.id === pipeline.campaignId);
  if (cidx === -1) return res.status(404).json({ error: "Campaign not found" });

  // Archive current versions before overwriting
  archiveCampaignVersion(userId, pipeline.campaignId, campaigns[cidx].stateSeedVersion || pipeline.fromVersion, campaigns[cidx].stateSeed, campaigns[cidx].systemPrompt);

  // Update campaign with approved documents (prefer auto-fixed seed if available)
  const seed = approvedStateSeed || pipeline.step2?.fixedSeed || pipeline.step1.result;
  campaigns[cidx].stateSeed = seed;
  campaigns[cidx].stateSeedVersion = pipeline.toVersion;
  campaigns[cidx].lastUpdated = new Date().toISOString();

  if (approvedSystemPrompt) {
    campaigns[cidx].systemPrompt = approvedSystemPrompt;
  }

  // Create new session if requested
  let newSessionId = null;
  if (startNewSession) {
    newSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    // Extract cold start from seed and inject as first message
    const coldStart = extractColdStart(seed);
    const initialMessages = coldStart ? [{ role: "cold-start", content: coldStart }] : [];
    const newSession = {
      id: newSessionId, name: "New Session", selectedModel: campaigns[cidx].pipelineModel || "claude-opus-4-6",
      temperature: 1, cacheTTL: "1h", thinkingMode: "adaptive", thinkingBudget: getMaxOut(campaigns[cidx].pipelineModel || "claude-opus-4-6") - 1,
      effort: "max", systemPrompt: campaigns[cidx].systemPrompt, stateSeed: seed,
      folderId: campaigns[cidx].folderId, campaignId: pipeline.campaignId, messages: initialMessages, createdAt: Date.now()
    };
    if (isMigrated(userId)) {
      saveSession(userId, newSession);
      updateSessionMeta(userId, newSession.id, buildSessionMeta(newSession));
      const meta = loadUserMeta(userId);
      meta.activeId = newSession.id;
      saveUserMeta(userId, meta);
    } else {
      const state = loadUserState(userId);
      if (state) {
        if (!state.sessions) state.sessions = {};
        if (typeof state.sessions === "object" && !Array.isArray(state.sessions)) state.sessions[newSessionId] = newSession;
        else { state.sessions = state.sessions || []; state.sessions.push(newSession); }
        state.activeId = newSessionId;
        saveUserState(userId, state);
      }
    }
    campaigns[cidx].activeSessionId = newSessionId;
  }

  saveCampaigns(userId, campaigns);

  // Mark pipeline as approved
  pipeline.status = "approved";
  pipeline.approvedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  res.json({ ok: true, newSessionId, campaignId: pipeline.campaignId, newVersion: pipeline.toVersion });
});

// ── Reject pipeline ──
router.post("/reject", requireAuth, (req, res) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });
  const pipeline = loadPipeline(req.session.userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  pipeline.status = "rejected";
  pipeline.rejectedAt = new Date().toISOString();
  savePipeline(req.session.userId, pipeline);
  res.json({ ok: true });
});

// ── Cancel — kill in-flight requests, mark cancelled ──
router.post("/cancel", requireAuth, (req, res) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });
  const pipeline = loadPipeline(req.session.userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  if (!["running", "running_step1", "running_step2", "running_step3"].includes(pipeline.status)) return res.status(400).json({ error: "Pipeline not running" });
  cancelRequests(pipelineId);
  pipeline.status = "cancelled";
  pipeline.completedAt = new Date().toISOString();
  pipeline.error = "Cancelled by user";
  if (pipeline.step1.status === "running") { pipeline.step1.status = "cancelled"; pipeline.step1.error = "Cancelled"; }
  if (pipeline.step2.status === "running") { pipeline.step2.status = "cancelled"; pipeline.step2.error = "Cancelled"; }
  if (pipeline.step3.status === "running") { pipeline.step3.status = "cancelled"; pipeline.step3.error = "Cancelled"; }
  savePipeline(req.session.userId, pipeline);
  res.json({ ok: true });
});

// ── Partial pipeline runners (for granular retry) ──

async function runFromValidation(userId, pipeline) {
  const keys = loadUserKeys(userId);
  const apiKey = keys.anthropic;
  if (!apiKey) { pipeline.status = "failed"; pipeline.error = "No Anthropic API key configured"; savePipeline(userId, pipeline); return; }
  const model = pipeline.model;

  // Step 2: Validation
  pipeline.step2.status = "running";
  pipeline.step2.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  try {
    const r = await runStep2(apiKey, model, pipeline, pipeline.id, userId);
    pipeline.step2.status = "complete";
    pipeline.step2.completedAt = new Date().toISOString();
    pipeline.step2.result = r.result;
    pipeline.step2.passed = r.passed;
    pipeline.step2.usage = r.usage;
    savePipeline(userId, pipeline);
  } catch (e) {
    pipeline.step2.status = "failed";
    pipeline.step2.error = e.message;
    savePipeline(userId, pipeline);
  }

  // Step 2.5: Auto-fix if validation failed (two-phase: surgical edits → apply)
  if (pipeline.step2.status === "complete" && !pipeline.step2.passed) {
    pipeline.step2.autoFixStatus = "running";
    savePipeline(userId, pipeline);
    try {
      const fixResult = await runStep2Fix(apiKey, model, pipeline, pipeline.id, userId);
      pipeline.step2.autoFixStatus = "complete";
      pipeline.step2.fixEdits = fixResult.result;
      pipeline.step2.fixUsage = fixResult.usage;
      savePipeline(userId, pipeline);
      console.log(`Pipeline ${pipeline.id} surgical fix edits generated`);

      pipeline.step2.fixApplyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep2FixApply(apiKey, model, pipeline, pipeline.id, userId);
        pipeline.step2.fixApplyStatus = "complete";
        pipeline.step2.fixedSeed = applyResult.result;
        pipeline.step2.fixApplyUsage = applyResult.usage;
        savePipeline(userId, pipeline);
        console.log(`Pipeline ${pipeline.id} surgical fix applied`);
      } catch (e) {
        pipeline.step2.fixApplyStatus = "failed";
        pipeline.step2.fixApplyError = e.message;
        savePipeline(userId, pipeline);
      }
    } catch (e) {
      pipeline.step2.autoFixStatus = "failed";
      pipeline.step2.autoFixError = e.message;
      savePipeline(userId, pipeline);
    }
  }

  clearTracked(pipeline.id);
  pipeline.status = "complete";
  pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
  console.log(`Pipeline ${pipeline.id} re-validation complete`);
}

async function runAutoFixOnly(userId, pipeline) {
  const keys = loadUserKeys(userId);
  const apiKey = keys.anthropic;
  if (!apiKey) { pipeline.status = "failed"; pipeline.error = "No Anthropic API key configured"; savePipeline(userId, pipeline); return; }
  const model = pipeline.model;

  pipeline.step2.autoFixStatus = "running";
  savePipeline(userId, pipeline);

  try {
    const fixResult = await runStep2Fix(apiKey, model, pipeline, pipeline.id, userId);
    pipeline.step2.autoFixStatus = "complete";
    pipeline.step2.fixEdits = fixResult.result;
    pipeline.step2.fixUsage = fixResult.usage;
    savePipeline(userId, pipeline);
    console.log(`Pipeline ${pipeline.id} surgical fix edits generated (retry)`);

    pipeline.step2.fixApplyStatus = "running";
    savePipeline(userId, pipeline);
    try {
      const applyResult = await runStep2FixApply(apiKey, model, pipeline, pipeline.id, userId);
      pipeline.step2.fixApplyStatus = "complete";
      pipeline.step2.fixedSeed = applyResult.result;
      pipeline.step2.fixApplyUsage = applyResult.usage;
      savePipeline(userId, pipeline);
      console.log(`Pipeline ${pipeline.id} surgical fix applied (retry)`);
    } catch (e) {
      pipeline.step2.fixApplyStatus = "failed";
      pipeline.step2.fixApplyError = e.message;
      savePipeline(userId, pipeline);
    }
  } catch (e) {
    pipeline.step2.autoFixStatus = "failed";
    pipeline.step2.autoFixError = e.message;
    savePipeline(userId, pipeline);
  }

  clearTracked(pipeline.id);
  pipeline.status = "complete";
  pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
}

async function runStep3Only(userId, pipeline) {
  const keys = loadUserKeys(userId);
  const apiKey = keys.anthropic;
  if (!apiKey) { pipeline.status = "failed"; pipeline.error = "No Anthropic API key configured"; savePipeline(userId, pipeline); return; }
  const model = pipeline.model;

  pipeline.step3.status = "running";
  pipeline.step3.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  try {
    const r = await runStep3(apiKey, model, pipeline, pipeline.id, userId);
    if (r.skipped) { pipeline.step3.status = "skipped"; pipeline.step3.result = r.result; }
    else { pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString(); pipeline.step3.result = r.result; pipeline.step3.usage = r.usage; }
    savePipeline(userId, pipeline);
    // Step 3.5: apply if changes recommended
    const hasChanges = r.result && !r.skipped && !/no changes needed/i.test(r.result);
    if (hasChanges) {
      pipeline.step3.applyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep3Apply(apiKey, model, pipeline, pipeline.id, userId);
        pipeline.step3.applyStatus = "complete";
        pipeline.step3.appliedResult = applyResult.result;
        pipeline.step3.applyUsage = applyResult.usage;
        savePipeline(userId, pipeline);
      } catch (e) {
        pipeline.step3.applyStatus = "failed";
        pipeline.step3.applyError = e.message;
        savePipeline(userId, pipeline);
      }
    }
  } catch (e) {
    pipeline.step3.status = "failed";
    pipeline.step3.error = e.message;
    savePipeline(userId, pipeline);
  }

  clearTracked(pipeline.id);
  pipeline.status = "complete";
  pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
}

// ── Retry — supports full re-run or granular retry from a specific step ──
router.post("/retry/:id", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const pipeline = loadPipeline(userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  const { fromStep } = req.body || {};

  if (fromStep === "2fix") {
    // Retry just the auto-fix — keep step1, step2 results
    pipeline.step2.autoFixStatus = null;
    pipeline.step2.autoFixError = null;
    pipeline.step2.fixEdits = null;
    pipeline.step2.fixUsage = null;
    pipeline.step2.fixApplyStatus = null;
    pipeline.step2.fixApplyError = null;
    pipeline.step2.fixApplyUsage = null;
    pipeline.step2.fixedSeed = null;
    pipeline.status = "running";
    pipeline.completedAt = null;
    pipeline.error = null;
    savePipeline(userId, pipeline);
    res.json({ ok: true, pipelineId: pipeline.id, status: pipeline.status });
    runAutoFixOnly(userId, pipeline).catch(e => { pipeline.status = "failed"; pipeline.error = `Retry error: ${e.message}`; savePipeline(userId, pipeline); });

  } else if (fromStep === 2) {
    // Re-run from validation — keep step1 result
    pipeline.step2 = { status: "pending", startedAt: null, completedAt: null, result: null, passed: null, usage: null, error: null };
    pipeline.status = "running";
    pipeline.completedAt = null;
    pipeline.error = null;
    savePipeline(userId, pipeline);
    res.json({ ok: true, pipelineId: pipeline.id, status: pipeline.status });
    runFromValidation(userId, pipeline).catch(e => { pipeline.status = "failed"; pipeline.error = `Retry error: ${e.message}`; savePipeline(userId, pipeline); });

  } else if (fromStep === 3) {
    // Re-run step 3 only — keep step1, step2
    pipeline.step3 = { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null };
    pipeline.status = "running";
    pipeline.completedAt = null;
    pipeline.error = null;
    savePipeline(userId, pipeline);
    res.json({ ok: true, pipelineId: pipeline.id, status: pipeline.status });
    runStep3Only(userId, pipeline).catch(e => { pipeline.status = "failed"; pipeline.error = `Retry error: ${e.message}`; savePipeline(userId, pipeline); });

  } else {
    // Full re-run (default)
    pipeline.step1 = { status: "pending", startedAt: null, completedAt: null, result: null, truncated: false, usage: null, error: null };
    pipeline.step2 = { status: "pending", startedAt: null, completedAt: null, result: null, passed: null, usage: null, error: null };
    pipeline.step3 = { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null };
    pipeline.status = "running";
    pipeline.startedAt = new Date().toISOString();
    pipeline.completedAt = null;
    pipeline.error = null;
    savePipeline(userId, pipeline);
    res.json({ ok: true, pipelineId: pipeline.id, status: pipeline.status });
    runPipeline(userId, pipeline).catch(e => { pipeline.status = "failed"; pipeline.error = `Retry error: ${e.message}`; savePipeline(userId, pipeline); });
  }
});

export default router;
