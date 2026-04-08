// ═══════════════════════════════════════════════════════════
// MULTI-PROVIDER PIPELINE — Non-Anthropic model support for state seed updates
// ═══════════════════════════════════════════════════════════
//
// Mounted at /api/pipeline BEFORE the frozen pipeline.js router.
// Intercepts /start and /retry/:id for non-Anthropic models,
// calling next() for Anthropic models so they fall through to pipeline.js.
// All other routes (/status, /full, /active, /history, /approve, /reject, /cancel)
// are NOT defined here — they fall through to pipeline.js identically.

import { Router } from "express";
import crypto from "crypto";
import { requireAuth, loadCampaigns, saveCampaigns, loadUserKeys, loadUserState, saveUserState, savePipeline, loadPipeline, pipelinesDir, archiveCampaignVersion, loadSession, saveSession, isMigrated, updateSessionMeta, buildSessionMeta, loadUserMeta, saveUserMeta, loadSessionsMeta } from "./shared.js";
import { readdirSync, existsSync } from "fs";
import { callModel, callCustomModel, getMaxOut, getCustomMaxOut, getModelInfo, isAnthropicModel, isCustomModel, parseCustomModelId } from "./providers/registry.js";
import { withRetry, cancelRequests, clearTracked, RETRYABLE_STATUS, MAX_RETRIES } from "./providers/base.js";
import { VALIDATION_PROMPT, FIX_PROMPT, FIX_APPLY_PROMPT, APPLY_DIFFS_PROMPT } from "./prompts.js";

const router = Router();

// ── Unified model call dispatcher (built-in or custom endpoint) ──
function dispatchCallModel(userId, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 2100000) {
  if (isCustomModel(model)) return callCustomModel(userId, model, messages, maxTokens, temperature, pipelineId, timeoutMs);
  return callModel(userId, model, messages, maxTokens, temperature, pipelineId, timeoutMs);
}
function dispatchGetMaxOut(userId, model) {
  if (isCustomModel(model)) return getCustomMaxOut(userId, model);
  return getMaxOut(model);
}

// ── Export transcript from session (mirrors pipeline.js) ──
function exportTranscript(session) {
  const META_PREFIXES = ["**Credit Balance Error:**", "**API Error:**", "**Network Error:**", "**Authentication Error:**", "*[Stopped before response began]*", "*[Response contained only thinking"];
  let md = `# ${session.name}\n\n`;
  for (const m of (session.messages || [])) {
    if (m.role === "cold-start") continue;
    if (META_PREFIXES.some(p => m.content?.startsWith(p))) continue;
    const clean = (m.content || "").replace(/\n\n\*\[Stopped\]\*$/, "").replace(/\n\n---\n\n\*\[Stream interrupted:.*?\]\*$/, "");
    if (!clean.trim()) continue;
    md += `### ${m.role === "user" ? "User" : "Assistant"}\n\n${clean}\n\n`;
  }
  return md;
}

// ═══════════════════════════════════════════════════════════
// STEP RUNNERS
// ═══════════════════════════════════════════════════════════

async function runStep1(userId, model, pipeline) {
  const maxOut = dispatchGetMaxOut(userId, model);
  const userMsg = `${pipeline.updatePromptTemplate}\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>\n\n<current_state_seed>\n${pipeline.currentStateSeed}\n</current_state_seed>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: userMsg }], maxOut, 0, pipeline.id, 2100000);
    if (res.retryableStatus) return res;
    return res;
  }, "step1", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);

  const fullText = r.text;
  const truncated = r.truncated;

  // Strip any leading assessment line
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

  return { result: lines.slice(seedStartIdx).join("\n").trim(), truncated, usage: r.usage };
}

async function runStep2(userId, model, pipeline) {
  const valMsg = `${VALIDATION_PROMPT}\n\n<new_state_seed>\n${pipeline.step1.result}\n</new_state_seed>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: valMsg }], 16384, 0, pipeline.id, 600000);
    if (res.retryableStatus) return res;
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);

  const valText = r.text;
  // Support both markdown bold and non-bold validation pass formats
  const passed = /\*\*VALIDATION:\s*PASS\*\*/i.test(valText) || /(^|\n)\s*VALIDATION:\s*PASS/im.test(valText);
  return { result: valText, passed, usage: r.usage };
}

async function runStep2Fix(userId, model, pipeline) {
  const msg = `${FIX_PROMPT}\n\n<validation_report>\n${pipeline.step2.result}\n</validation_report>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>\n\n<previous_state_seed>\n${pipeline.currentStateSeed}\n</previous_state_seed>\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: msg }], 16384, 0, pipeline.id, 600000);
    if (res.retryableStatus) return res;
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  return { result: r.text, usage: r.usage };
}

async function runStep2FixApply(userId, model, pipeline) {
  const maxOut = dispatchGetMaxOut(userId, model);
  const msg = `${FIX_APPLY_PROMPT}\n\n<surgical_edits>\n${pipeline.step2.fixEdits}\n</surgical_edits>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>\n\n<previous_state_seed>\n${pipeline.currentStateSeed}\n</previous_state_seed>\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: msg }], maxOut, 0, pipeline.id, 1200000);
    if (res.retryableStatus) return res;
    return res;
  }, "step2", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  return { result: r.text, usage: r.usage };
}

async function runStep3(userId, model, pipeline) {
  if (!pipeline.systemPromptUpdateTemplate) return { result: "No system prompt update template configured", skipped: true };

  const sysMsg = `${pipeline.systemPromptUpdateTemplate}\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: sysMsg }], 16384, 0, pipeline.id, 600000);
    if (res.retryableStatus) return res;
    return res;
  }, "step3", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  return { result: r.text, usage: r.usage };
}

async function runStep3Apply(userId, model, pipeline) {
  const maxOut = dispatchGetMaxOut(userId, model);
  const msg = `${APPLY_DIFFS_PROMPT}\n\n<surgical_edits>\n${pipeline.step3.result}\n</surgical_edits>\n\n<system_prompt>\n${pipeline.systemPrompt}\n</system_prompt>\n\n<session_transcript>\n${pipeline.transcript}\n</session_transcript>\n\n<previous_state_seed>\n${pipeline.currentStateSeed}\n</previous_state_seed>`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: msg }], maxOut, 0, pipeline.id, 1200000);
    if (res.retryableStatus) return res;
    return res;
  }, "step3", pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  return { result: r.text, usage: r.usage };
}

// ═══════════════════════════════════════════════════════════
// PIPELINE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════

async function runPipeline(userId, pipeline) {
  const model = pipeline.model;

  // ── Step 1 (seed generation) and Step 3 (system prompt assessment) run in PARALLEL ──
  pipeline.step1.status = "running";
  pipeline.step1.startedAt = new Date().toISOString();
  pipeline.step3.status = pipeline.systemPromptUpdateTemplate ? "running" : "skipped";
  if (pipeline.step3.status === "running") pipeline.step3.startedAt = new Date().toISOString();
  pipeline.status = "running";
  savePipeline(userId, pipeline);

  const step1Promise = runStep1(userId, model, pipeline).then(r => {
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

  const step3Promise = pipeline.systemPromptUpdateTemplate ? runStep3(userId, model, pipeline).then(async (r) => {
    if (r.skipped) { pipeline.step3.status = "skipped"; pipeline.step3.result = r.result; }
    else { pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString(); pipeline.step3.result = r.result; pipeline.step3.usage = r.usage; }
    savePipeline(userId, pipeline);
    // Step 3.5: If changes recommended, apply them to produce the updated system prompt
    const hasChanges = r.result && !r.skipped && !/no changes needed/i.test(r.result);
    if (hasChanges) {
      pipeline.step3.applyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep3Apply(userId, model, pipeline);
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
    const r = await runStep2(userId, model, pipeline);
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
      const fixResult = await runStep2Fix(userId, model, pipeline);
      pipeline.step2.autoFixStatus = "complete";
      pipeline.step2.fixEdits = fixResult.result;
      pipeline.step2.fixUsage = fixResult.usage;
      savePipeline(userId, pipeline);
      console.log(`Pipeline ${pipeline.id} surgical fix edits generated`);

      // Step 2.5b: Apply the surgical edits to produce the corrected state seed
      pipeline.step2.fixApplyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep2FixApply(userId, model, pipeline);
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
// PARTIAL PIPELINE RUNNERS (for granular retry)
// ═══════════════════════════════════════════════════════════

async function runFromValidation(userId, pipeline) {
  const model = pipeline.model;

  pipeline.step2.status = "running";
  pipeline.step2.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  try {
    const r = await runStep2(userId, model, pipeline);
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
      const fixResult = await runStep2Fix(userId, model, pipeline);
      pipeline.step2.autoFixStatus = "complete";
      pipeline.step2.fixEdits = fixResult.result;
      pipeline.step2.fixUsage = fixResult.usage;
      savePipeline(userId, pipeline);
      console.log(`Pipeline ${pipeline.id} surgical fix edits generated`);

      pipeline.step2.fixApplyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep2FixApply(userId, model, pipeline);
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
  const model = pipeline.model;

  pipeline.step2.autoFixStatus = "running";
  savePipeline(userId, pipeline);

  try {
    const fixResult = await runStep2Fix(userId, model, pipeline);
    pipeline.step2.autoFixStatus = "complete";
    pipeline.step2.fixEdits = fixResult.result;
    pipeline.step2.fixUsage = fixResult.usage;
    savePipeline(userId, pipeline);
    console.log(`Pipeline ${pipeline.id} surgical fix edits generated (retry)`);

    pipeline.step2.fixApplyStatus = "running";
    savePipeline(userId, pipeline);
    try {
      const applyResult = await runStep2FixApply(userId, model, pipeline);
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
  const model = pipeline.model;

  pipeline.step3.status = "running";
  pipeline.step3.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  try {
    const r = await runStep3(userId, model, pipeline);
    if (r.skipped) { pipeline.step3.status = "skipped"; pipeline.step3.result = r.result; }
    else { pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString(); pipeline.step3.result = r.result; pipeline.step3.usage = r.usage; }
    savePipeline(userId, pipeline);
    // Step 3.5: apply if changes recommended
    const hasChanges = r.result && !r.skipped && !/no changes needed/i.test(r.result);
    if (hasChanges) {
      pipeline.step3.applyStatus = "running";
      savePipeline(userId, pipeline);
      try {
        const applyResult = await runStep3Apply(userId, model, pipeline);
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

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── Start pipeline (intercepts non-Anthropic models, falls through for Anthropic) ──
router.post("/start", requireAuth, (req, res, next) => {
  const userId = req.session.userId;
  const { campaignId, sessionId } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const campaigns = loadCampaigns(userId);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const model = campaign.pipelineModel || "claude-opus-4-6";

  // If Anthropic model, fall through to frozen pipeline.js
  if (isAnthropicModel(model)) return next();

  // Check if model is registered in the registry (or is a custom endpoint model)
  if (!isCustomModel(model) && !getModelInfo(model)) return res.status(400).json({ error: `Model "${model}" is not supported for pipeline use` });
  if (isCustomModel(model)) {
    const parsed = parseCustomModelId(model);
    if (!parsed) return res.status(400).json({ error: `Invalid custom model ID: "${model}"` });
    const keys = loadUserKeys(userId);
    const ep = (keys.customEndpoints || []).find(e => e.id === parsed.endpointId);
    if (!ep) return res.status(400).json({ error: `Custom endpoint not found. Configure it in Settings.` });
  }

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
    type: "multi",
    campaignId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    model,
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

// ── Retry (intercepts non-Anthropic models, falls through for Anthropic) ──
router.post("/retry/:id", requireAuth, (req, res, next) => {
  const userId = req.session.userId;
  const pipeline = loadPipeline(userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  // If Anthropic model, fall through to frozen pipeline.js
  if (isAnthropicModel(pipeline.model)) return next();

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

// ── Cancel (intercepts non-Anthropic models, falls through for Anthropic) ──
router.post("/cancel", requireAuth, (req, res, next) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });
  const pipeline = loadPipeline(req.session.userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  // If Anthropic model, fall through to frozen pipeline.js
  if (isAnthropicModel(pipeline.model)) return next();

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

export default router;
