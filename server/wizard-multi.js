// ═══════════════════════════════════════════════════════════
// wizard-multi.js — Multi-provider wizard pipeline
// Mounted BEFORE frozen wizard.js; intercepts /generate and
// /cancel for non-Anthropic models, falls through otherwise.
// ═══════════════════════════════════════════════════════════

import { Router } from "express";
import crypto from "crypto";
import https from "https";
import {
  requireAuth, loadWizardTemplates, saveWizardTemplates,
  loadUserKeys, loadUserState, saveUserState,
  loadCampaigns, saveCampaigns, pipelinesDir,
  savePipeline, loadPipeline, userDataDir,
  loadSession, saveSession, isMigrated,
  deleteSessionFile, removeSessionMeta, updateSessionMeta,
  buildSessionMeta, loadUserMeta, saveUserMeta
} from "./shared.js";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { callModel, callCustomModel, getMaxOut, getCustomMaxOut, getModelInfo, isAnthropicModel, isCustomModel, parseCustomModelId } from "./providers/registry.js";
import { withRetry, cancelRequests, clearTracked, RETRYABLE_STATUS, MAX_RETRIES } from "./providers/base.js";
import { GEN_SEED_PROMPT, GEN_SYSPROMPT_PROMPT, GEN_SEED_UPDATE_PROMPT, GEN_SYSPROMPT_UPDATE_PROMPT } from "./prompts.js";

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

// ── Export wizard transcript (same logic as frozen wizard.js) ──
function exportWizardTranscript(session) {
  let md = "";
  for (const m of (session.messages || [])) {
    if (!m.content?.trim()) continue;
    md += `### ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content}\n\n`;
  }
  return md;
}

// ═══════════════════════════════════════════════════════════
// STEP RUNNER
// ═══════════════════════════════════════════════════════════

async function runWizardStep(userId, model, prompt, context, pipelineId, pipeline, stepKey) {
  const maxOut = dispatchGetMaxOut(userId, model);
  const userMsg = `${prompt}\n\n${context}`;

  const r = await withRetry(async () => {
    const res = await dispatchCallModel(userId, model, [{ role: "user", content: userMsg }], maxOut, 0, pipelineId, 1200000);
    if (res.retryableStatus) return res;
    return res;
  }, stepKey, pipeline, userId);

  if (r.retryableStatus) throw new Error(`API returned ${r.retryableStatus} after ${MAX_RETRIES} retries`);
  return { result: r.text, usage: r.usage };
}

// ═══════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════

async function runWizardPipeline(userId, pipeline) {
  const model = pipeline.model;
  const transcript = pipeline.wizardTranscript;
  const exSeed = pipeline.exampleStateSeed;
  const exSysPrompt = pipeline.exampleSystemPrompt;
  const seedUpdTpl = pipeline.seedUpdateTemplate;
  const sysUpdTpl = pipeline.sysPromptUpdateTemplate;

  // ── Phase 1: Steps 1+2 in parallel ──
  pipeline.step1.status = "running"; pipeline.step1.startedAt = new Date().toISOString();
  pipeline.step2.status = "running"; pipeline.step2.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  const ctx1 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<example_state_seed>\n${exSeed}\n</example_state_seed>`;
  const ctx2 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<example_system_prompt>\n${exSysPrompt}\n</example_system_prompt>`;

  const step1Promise = runWizardStep(userId, model, GEN_SEED_PROMPT, ctx1, pipeline.id, pipeline, "step1").then(r => {
    pipeline.step1.status = "complete"; pipeline.step1.completedAt = new Date().toISOString();
    pipeline.step1.result = r.result; pipeline.step1.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => {
    pipeline.step1.status = "failed"; pipeline.step1.error = e.message;
    savePipeline(userId, pipeline);
    throw e;
  });

  const step2Promise = runWizardStep(userId, model, GEN_SYSPROMPT_PROMPT, ctx2, pipeline.id, pipeline, "step2").then(r => {
    pipeline.step2.status = "complete"; pipeline.step2.completedAt = new Date().toISOString();
    pipeline.step2.result = r.result; pipeline.step2.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => {
    pipeline.step2.status = "failed"; pipeline.step2.error = e.message;
    savePipeline(userId, pipeline);
    throw e;
  });

  // Wait for both Phase 1 steps
  try {
    await Promise.all([step1Promise, step2Promise]);
  } catch (e) {
    // If either Phase 1 step failed, pipeline fails
    await Promise.allSettled([step1Promise, step2Promise]);
    pipeline.status = "failed"; pipeline.error = `Phase 1 failed: ${e.message}`;
    pipeline.completedAt = new Date().toISOString();
    clearTracked(pipeline.id);
    savePipeline(userId, pipeline);
    return;
  }

  // ── Phase 2: Steps 3+4 in parallel (need step1+step2 results as context) ──
  pipeline.step3.status = "running"; pipeline.step3.startedAt = new Date().toISOString();
  pipeline.step4.status = "running"; pipeline.step4.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  const ctx3 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<shared_template>\n${seedUpdTpl}\n</shared_template>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<generated_system_prompt>\n${pipeline.step2.result}\n</generated_system_prompt>`;
  const ctx4 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<shared_template>\n${sysUpdTpl}\n</shared_template>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<generated_system_prompt>\n${pipeline.step2.result}\n</generated_system_prompt>`;

  const step3Promise = runWizardStep(userId, model, GEN_SEED_UPDATE_PROMPT, ctx3, pipeline.id, pipeline, "step3").then(r => {
    pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString();
    pipeline.step3.result = r.result; pipeline.step3.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => {
    pipeline.step3.status = "failed"; pipeline.step3.error = e.message;
    savePipeline(userId, pipeline);
  });

  const step4Promise = runWizardStep(userId, model, GEN_SYSPROMPT_UPDATE_PROMPT, ctx4, pipeline.id, pipeline, "step4").then(r => {
    pipeline.step4.status = "complete"; pipeline.step4.completedAt = new Date().toISOString();
    pipeline.step4.result = r.result; pipeline.step4.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => {
    pipeline.step4.status = "failed"; pipeline.step4.error = e.message;
    savePipeline(userId, pipeline);
  });

  await Promise.allSettled([step3Promise, step4Promise]);

  clearTracked(pipeline.id);
  pipeline.status = "complete";
  pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── Generate (intercepts non-Anthropic models, falls through for Anthropic) ──
router.post("/generate", requireAuth, (req, res, next) => {
  const userId = req.session.userId;
  const { sessionId, model } = req.body || {};

  const pipelineModel = model || "claude-opus-4-6";

  // If Anthropic model, fall through to frozen wizard.js
  if (isAnthropicModel(pipelineModel)) return next();

  // Validate model is registered (or is a custom endpoint model)
  if (!isCustomModel(pipelineModel) && !getModelInfo(pipelineModel)) {
    return res.status(400).json({ error: `Model "${pipelineModel}" is not registered` });
  }
  if (isCustomModel(pipelineModel)) {
    const parsed = parseCustomModelId(pipelineModel);
    if (!parsed) return res.status(400).json({ error: `Invalid custom model ID: "${pipelineModel}"` });
    const keys = loadUserKeys(userId);
    const ep = (keys.customEndpoints || []).find(e => e.id === parsed.endpointId);
    if (!ep) return res.status(400).json({ error: `Custom endpoint not found. Configure it in Settings.` });
  }

  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  let session;
  if (isMigrated(userId)) {
    session = loadSession(userId, sessionId);
  } else {
    const state = loadUserState(userId);
    if (!state) return res.status(400).json({ error: "No user state" });
    session = state.sessions?.[sessionId];
  }
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.sessionType !== "wizard") return res.status(400).json({ error: "Not a wizard session" });

  const templates = loadWizardTemplates(userId);
  const transcript = exportWizardTranscript(session);

  // Extract campaign name from the conversation
  let campaignName = session.wizardCampaignName || "New Campaign";
  const briefMatch = transcript.match(/## Campaign Brief:\s*(.+)/);
  if (briefMatch) campaignName = briefMatch[1].trim();

  const pipeline = {
    id: crypto.randomBytes(12).toString("hex"),
    type: "wizard",
    multiModel: true,
    campaignName,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    model: pipelineModel,
    wizardSessionId: sessionId,
    wizardTranscript: transcript,
    exampleStateSeed: templates.exampleStateSeed || "",
    exampleSystemPrompt: templates.exampleSystemPrompt || "",
    seedUpdateTemplate: templates.seedUpdateTemplate || "",
    sysPromptUpdateTemplate: templates.sysPromptUpdateTemplate || "",
    error: null,
    step1: { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null },
    step2: { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null },
    step3: { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null },
    step4: { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null }
  };

  savePipeline(userId, pipeline);
  res.json({ pipelineId: pipeline.id, status: pipeline.status });

  runWizardPipeline(userId, pipeline).catch(e => {
    pipeline.status = "failed"; pipeline.error = `Unexpected error: ${e.message}`;
    savePipeline(userId, pipeline);
    console.error(`Wizard pipeline ${pipeline.id} error:`, e);
  });
});

// ── Cancel (intercepts multi-model pipelines, falls through otherwise) ──
router.post("/cancel", requireAuth, (req, res, next) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });

  const pipeline = loadPipeline(req.session.userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  // If not a multi-model pipeline, fall through to frozen wizard.js
  if (!pipeline.multiModel) return next();

  cancelRequests(pipelineId);
  pipeline.status = "cancelled"; pipeline.completedAt = new Date().toISOString(); pipeline.error = "Cancelled by user";
  for (const key of ["step1", "step2", "step3", "step4"]) {
    if (pipeline[key]?.status === "running") {
      pipeline[key].status = "cancelled"; pipeline[key].error = "Cancelled";
    }
  }
  savePipeline(req.session.userId, pipeline);
  res.json({ ok: true });
});

export default router;
