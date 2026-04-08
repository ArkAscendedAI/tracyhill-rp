// ═══════════════════════════════════════════════════════════
// CAMPAIGN WIZARD — Template management + wizard generation pipeline
// ═══════════════════════════════════════════════════════════

import { Router } from "express";
import crypto from "crypto";
import https from "https";
import { requireAuth, loadWizardTemplates, saveWizardTemplates, loadUserKeys, loadUserState, saveUserState, loadCampaigns, saveCampaigns, pipelinesDir, savePipeline, loadPipeline, userDataDir, loadSession, saveSession, isMigrated, deleteSessionFile, removeSessionMeta, updateSessionMeta, buildSessionMeta, loadUserMeta, saveUserMeta } from "./shared.js";
import { existsSync, readdirSync, mkdirSync } from "fs";

const router = Router();

// ── Extract cold start section from state seed ──
function extractColdStart(seed) {
  if (!seed) return null;
  const headerPattern = /^(#{1,3})\s*(?:(?:section\s+\w+\s*[—–-]\s*)?(?:cold\s*start|orientation|cold\s*start\s*[\/&]\s*orientation|session\s*start))\b[^\n]*/im;
  const match = seed.match(headerPattern);
  if (!match) return null;
  const headerLevel = match[1].length;
  const startIdx = match.index;
  const rest = seed.slice(startIdx + match[0].length);
  const nextHeader = rest.match(new RegExp(`^#{1,${headerLevel}}\\s`, "m"));
  const content = nextHeader ? rest.slice(0, nextHeader.index).trim() : rest.trim();
  const full = match[0] + "\n" + content;
  return full.trim() || null;
}

// ── Model output limits (sync with pipeline.js) ──
const MODEL_MAX_OUT = { "claude-opus-4-6": 128000, "claude-sonnet-4-6": 64000, "claude-sonnet-4": 64000, "claude-haiku-4.5": 64000 };
function getMaxOut(modelId) { return MODEL_MAX_OUT[modelId] || 64000; }

// ── Active request tracking (for cancellation) ──
const activeRequests = new Map();
function trackRequest(pipelineId, req) { if (!activeRequests.has(pipelineId)) activeRequests.set(pipelineId, []); activeRequests.get(pipelineId).push(req); }
function cancelRequests(pipelineId) { const reqs = activeRequests.get(pipelineId) || []; for (const r of reqs) { try { r.destroy(new Error("Wizard cancelled")); } catch {} } activeRequests.delete(pipelineId); }
function clearTracked(pipelineId) { activeRequests.delete(pipelineId); }

// ── Anthropic API helper (non-streaming) ──
function anthropicPost(apiKey, model, messages, maxTokens, temperature = 0, pipelineId = null, timeoutMs = 1200000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: maxTokens, temperature, messages });
    const req = https.request({
      hostname: "api.anthropic.com", port: 443, path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { resolve({ status: res.statusCode, data: { error: { message: "Parse error" } } }); } });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Wizard API timeout (${Math.round(timeoutMs / 60000)}min)`)); });
    if (pipelineId) trackRequest(pipelineId, req);
    req.write(body);
    req.end();
  });
}

// ── Retry wrapper ──
const RETRYABLE = (err) => err.message?.includes("timeout") || err.message?.includes("ECONNRESET") || err.message?.includes("socket hang up");
const RETRYABLE_STATUS = (status) => [429, 500, 502, 503, 529].includes(status);
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15000, 30000];

async function withRetry(fn, label, pipeline, userId) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fn();
      if (r?.retryableStatus && attempt < MAX_RETRIES) {
        console.log(`Wizard ${pipeline.id} ${label}: retryable status ${r.retryableStatus}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt] || 30000));
        continue;
      }
      return r;
    } catch (e) {
      if (RETRYABLE(e) && attempt < MAX_RETRIES) {
        console.log(`Wizard ${pipeline.id} ${label}: ${e.message}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt] || 30000));
        continue;
      }
      throw e;
    }
  }
}

function extractText(data) {
  if (!data?.content) return "";
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

// ── Export wizard transcript ──
function exportWizardTranscript(session) {
  let md = "";
  for (const m of (session.messages || [])) {
    if (!m.content?.trim()) continue;
    md += `### ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content}\n\n`;
  }
  return md;
}

// ═══════════════════════════════════════════════════════════
// GENERATION PROMPTS
// ═══════════════════════════════════════════════════════════

const GEN_SEED_PROMPT = `You are creating an initial state seed (v0) for a brand new collaborative fiction campaign. No sessions have been played yet.

You have been provided:
1. A wizard conversation where the user described their campaign
2. An example state seed from a mature campaign (for structural reference only — do NOT copy its content)

Produce a complete state seed following the section structure from the example (A through I). Since this is v0 with no sessions played:
- **Section A (Cold Start):** Write the opening scenario from the premise. Include exact in-world date/time, location, situation, moon phase / time-of-day if relevant.
- **Section B (Premise & Constants):** Main character backstory, world rules, special mechanics, canon divergences if applicable.
- **Section C (Active State):** "No sessions played yet." — leave empty with this note.
- **Section D-E (History):** Empty — no history exists.
- **Section F (Relationship Map):** All NPCs from the wizard, with Status "Not yet met" or "Starting relationship" as appropriate. Include physical descriptions and voice notes from the wizard.
- **Section G (Information Boundaries):** MC's starting knowledge. NPCs know nothing about MC yet (unless the premise says otherwise).
- **Section H (Active Threads):** Initial threads from the premise — classify as Operational or Strategic per the example's format.
- **Section I (Session End State):** Starting character positions, emotional temperature, the opening moment.

Use the example seed for STRUCTURAL patterns only. ALL content must come from the wizard conversation. Output only the document — no commentary.`;

const GEN_SYSPROMPT_PROMPT = `You are creating a system prompt for a brand new collaborative fiction campaign. This document will be injected into EVERY turn of roleplay, so it must be invariant (true regardless of session).

You have been provided:
1. A wizard conversation where the user described their campaign
2. An example system prompt from a mature campaign (for structural reference only — do NOT copy its content)

Produce a complete system prompt following the example's structure:
- **Character voice descriptions** for every NPC from the wizard: physical description, voice registers (2-3 per character), voice anchors (2-3 signature lines/phrases per character). If the user didn't provide enough detail, create voice firmware that fits the character concept.
- **World-state constants** relevant to this universe (geography, social structure, magic/technology rules, daily life patterns, currency if relevant).
- **Style discipline rules** matching the tone described in the wizard (darkness level, violence handling, profanity, social dynamics).
- **Response economy rules** (length targets for different scene types, metaphor budget, POV rules).
- **Information boundary rules** (characters only know what they've witnessed or been told on-screen).
- **Character control rule** — whether the AI writes for the main character or not (from wizard conversation).
- **Physical presentation rules** for the main character if relevant.

Use the example system prompt for STRUCTURAL patterns only. ALL content must come from the wizard conversation. Output only the document — no commentary.`;

const GEN_SEED_UPDATE_PROMPT = `You are creating a campaign-specific state seed update prompt. This prompt will be used after each roleplay session to generate an updated state seed.

You have been provided:
1. A wizard conversation describing the campaign
2. A shared structural template that defines the universal update prompt format
3. The campaign's initial state seed (v0) for context
4. The campaign's system prompt for context

The shared template is ~70% universal structure (section definitions, compression cascade, self-containment rules, thread classification, writing rules). Your task: produce the COMPLETE update prompt with the ~30% campaign-specific customization integrated:
- Campaign-specific thread types and what to watch for in this universe
- Campaign-specific information boundary considerations (what knowledge systems matter here)
- Any universe-specific compression guidance (what details are fragile and shouldn't be compressed)
- Any campaign-specific writing rules or constraints from the wizard

Start from the shared template and weave in the campaign-specific parts. Do NOT strip any structural rules from the template. Output only the complete update prompt — no commentary.`;

const GEN_SYSPROMPT_UPDATE_PROMPT = `You are creating a campaign-specific system prompt update prompt. This prompt will be used after each roleplay session to assess whether the system prompt needs surgical edits.

You have been provided:
1. A wizard conversation describing the campaign
2. A shared structural template for system prompt updates
3. The campaign's initial state seed (v0) for context
4. The campaign's system prompt for context

Customize the template for this campaign:
- What types of characters to watch for (relevant to this universe's social structure)
- What constitutes a "confirmed capability" in this universe's mechanics
- Any campaign-specific conservatism rules (things that should NOT be added to the system prompt)
- Universe-specific entity types or reference blocks to maintain

Start from the shared template and integrate campaign-specific customization. Output only the complete update prompt — no commentary.`;

// ═══════════════════════════════════════════════════════════
// PIPELINE EXECUTION
// ═══════════════════════════════════════════════════════════

async function runWizardStep(apiKey, model, prompt, context, pipelineId, userId, pipeline, stepKey) {
  const msg = `${prompt}\n\n${context}`;
  const maxOut = getMaxOut(model);
  const r = await withRetry(async () => {
    const res = await anthropicPost(apiKey, model, [{ role: "user", content: msg }], maxOut, 0, pipelineId, 1200000);
    if (RETRYABLE_STATUS(res.status)) return { retryableStatus: res.status, data: res.data };
    return res;
  }, stepKey, pipeline, userId);

  if (r.retryableStatus) throw new Error(r.data?.error?.message || `API returned ${r.retryableStatus} after retries`);
  if (r.status !== 200) throw new Error(r.data?.error?.message || `API returned ${r.status}`);
  return { result: extractText(r.data), usage: r.data?.usage || null };
}

async function runWizardPipeline(userId, pipeline) {
  const keys = loadUserKeys(userId);
  const apiKey = keys.anthropic;
  if (!apiKey) { pipeline.status = "failed"; pipeline.error = "No Anthropic API key configured"; savePipeline(userId, pipeline); return; }

  const model = pipeline.model;
  const transcript = pipeline.wizardTranscript;
  const exSeed = pipeline.exampleStateSeed;
  const exSysPrompt = pipeline.exampleSystemPrompt;
  const seedUpdTpl = pipeline.seedUpdateTemplate;
  const sysUpdTpl = pipeline.sysPromptUpdateTemplate;

  // ── Phase 1: Steps 1+2 in parallel (seed + system prompt) ──
  pipeline.step1.status = "running"; pipeline.step1.startedAt = new Date().toISOString();
  pipeline.step2.status = "running"; pipeline.step2.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  const ctx1 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<example_state_seed>\n${exSeed}\n</example_state_seed>`;
  const ctx2 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<example_system_prompt>\n${exSysPrompt}\n</example_system_prompt>`;

  const step1Promise = runWizardStep(apiKey, model, GEN_SEED_PROMPT, ctx1, pipeline.id, userId, pipeline, "step1").then(r => {
    pipeline.step1.status = "complete"; pipeline.step1.completedAt = new Date().toISOString();
    pipeline.step1.result = r.result; pipeline.step1.usage = r.usage;
    savePipeline(userId, pipeline);
    return r;
  }).catch(e => { pipeline.step1.status = "failed"; pipeline.step1.error = e.message; savePipeline(userId, pipeline); throw e; });

  const step2Promise = runWizardStep(apiKey, model, GEN_SYSPROMPT_PROMPT, ctx2, pipeline.id, userId, pipeline, "step2").then(r => {
    pipeline.step2.status = "complete"; pipeline.step2.completedAt = new Date().toISOString();
    pipeline.step2.result = r.result; pipeline.step2.usage = r.usage;
    savePipeline(userId, pipeline);
    return r;
  }).catch(e => { pipeline.step2.status = "failed"; pipeline.step2.error = e.message; savePipeline(userId, pipeline); throw e; });

  try {
    await Promise.all([step1Promise, step2Promise]);
  } catch (e) {
    // If either failed, wait for the other to finish, then mark pipeline failed
    await step1Promise.catch(() => {}); await step2Promise.catch(() => {});
    pipeline.status = "failed"; pipeline.error = `Phase 1 failed: ${e.message}`; savePipeline(userId, pipeline); return;
  }

  // ── Phase 2: Steps 3+4 in parallel (update prompts, with step 1+2 results as context) ──
  pipeline.step3.status = "running"; pipeline.step3.startedAt = new Date().toISOString();
  pipeline.step4.status = "running"; pipeline.step4.startedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  const ctx3 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<shared_template>\n${seedUpdTpl}\n</shared_template>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<generated_system_prompt>\n${pipeline.step2.result}\n</generated_system_prompt>`;
  const ctx4 = `<wizard_conversation>\n${transcript}\n</wizard_conversation>\n\n<shared_template>\n${sysUpdTpl}\n</shared_template>\n\n<generated_state_seed>\n${pipeline.step1.result}\n</generated_state_seed>\n\n<generated_system_prompt>\n${pipeline.step2.result}\n</generated_system_prompt>`;

  const step3Promise = runWizardStep(apiKey, model, GEN_SEED_UPDATE_PROMPT, ctx3, pipeline.id, userId, pipeline, "step3").then(r => {
    pipeline.step3.status = "complete"; pipeline.step3.completedAt = new Date().toISOString();
    pipeline.step3.result = r.result; pipeline.step3.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => { pipeline.step3.status = "failed"; pipeline.step3.error = e.message; savePipeline(userId, pipeline); });

  const step4Promise = runWizardStep(apiKey, model, GEN_SYSPROMPT_UPDATE_PROMPT, ctx4, pipeline.id, userId, pipeline, "step4").then(r => {
    pipeline.step4.status = "complete"; pipeline.step4.completedAt = new Date().toISOString();
    pipeline.step4.result = r.result; pipeline.step4.usage = r.usage;
    savePipeline(userId, pipeline);
  }).catch(e => { pipeline.step4.status = "failed"; pipeline.step4.error = e.message; savePipeline(userId, pipeline); });

  await Promise.all([step3Promise, step4Promise]);

  clearTracked(pipeline.id);
  pipeline.status = "complete"; pipeline.completedAt = new Date().toISOString();
  savePipeline(userId, pipeline);
  console.log(`Wizard pipeline ${pipeline.id} complete: ${pipeline.campaignName}`);
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── Wizard templates CRUD ──
router.get("/templates", requireAuth, (req, res) => { res.json(loadWizardTemplates(req.session.userId)); });
router.put("/templates", requireAuth, (req, res) => {
  const { exampleStateSeed, exampleSystemPrompt, seedUpdateTemplate, sysPromptUpdateTemplate } = req.body || {};
  const templates = loadWizardTemplates(req.session.userId);
  if (exampleStateSeed !== undefined) templates.exampleStateSeed = exampleStateSeed;
  if (exampleSystemPrompt !== undefined) templates.exampleSystemPrompt = exampleSystemPrompt;
  if (seedUpdateTemplate !== undefined) templates.seedUpdateTemplate = seedUpdateTemplate;
  if (sysPromptUpdateTemplate !== undefined) templates.sysPromptUpdateTemplate = sysPromptUpdateTemplate;
  saveWizardTemplates(req.session.userId, templates);
  res.json({ ok: true });
});

// ── Start wizard generation ──
router.post("/generate", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { sessionId, model } = req.body || {};
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

  // Extract campaign name from the conversation (look for it in early assistant messages)
  let campaignName = session.wizardCampaignName || "New Campaign";
  // Try to find name from brief
  const briefMatch = transcript.match(/## Campaign Brief:\s*(.+)/);
  if (briefMatch) campaignName = briefMatch[1].trim();

  const pipelineModel = model || "claude-opus-4-6";
  const pipeline = {
    id: crypto.randomBytes(12).toString("hex"),
    type: "wizard",
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

// ── Poll status ──
router.get("/status/:id", requireAuth, (req, res) => {
  const pipeline = loadPipeline(req.session.userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  const { wizardTranscript, exampleStateSeed, exampleSystemPrompt, seedUpdateTemplate, sysPromptUpdateTemplate, ...meta } = pipeline;
  res.json(meta);
});

// ── Full results ──
router.get("/full/:id", requireAuth, (req, res) => {
  const pipeline = loadPipeline(req.session.userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  res.json({
    id: pipeline.id, type: pipeline.type, campaignName: pipeline.campaignName, status: pipeline.status,
    startedAt: pipeline.startedAt, completedAt: pipeline.completedAt, model: pipeline.model,
    wizardSessionId: pipeline.wizardSessionId, error: pipeline.error,
    step1: pipeline.step1, step2: pipeline.step2, step3: pipeline.step3, step4: pipeline.step4
  });
});

// ── Check for active wizard pipeline ──
router.get("/active", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const dir = pipelinesDir(userId);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : [];
  for (const f of files.sort().reverse()) {
    try {
      const p = loadPipeline(userId, f.replace(".json", ""));
      if (p && p.type === "wizard" && ["running", "complete", "failed", "cancelled"].includes(p.status)) {
        return res.json({ active: true, pipelineId: p.id, status: p.status, campaignName: p.campaignName });
      }
    } catch {}
  }
  res.json({ active: false });
});

// ── Approve — create campaign, folder, session ──
router.post("/approve", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { pipelineId, editedSeed, editedSysPrompt, editedSeedUpdate, editedSysPromptUpdate } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });

  const pipeline = loadPipeline(userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  if (pipeline.status !== "complete") return res.status(400).json({ error: "Pipeline not complete" });

  const seed = editedSeed || pipeline.step1.result || "";
  const sysPrompt = editedSysPrompt || pipeline.step2.result || "";
  const seedUpdate = editedSeedUpdate || pipeline.step3.result || "";
  const sysPromptUpdate = editedSysPromptUpdate || pipeline.step4.result || "";
  const campaignName = pipeline.campaignName || "New Campaign";

  // Create campaign folder
  const folderId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newFolder = { id: folderId, name: campaignName, parentId: null, collapsed: false };

  // Create campaign record
  const campaigns = loadCampaigns(userId);
  const campaignId = crypto.randomBytes(12).toString("hex");
  campaigns.push({
    id: campaignId, name: campaignName, folderId, systemPrompt: sysPrompt, stateSeed: seed,
    stateSeedVersion: 0, updatePromptTemplate: seedUpdate, systemPromptUpdateTemplate: sysPromptUpdate,
    pipelineModel: pipeline.model, lastUpdated: new Date().toISOString(), activeSessionId: null
  });

  // Create first RP session
  const newSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const mi = MODEL_MAX_OUT[pipeline.model] ? pipeline.model : "claude-opus-4-6";
  // Extract cold start from seed and inject as first message
  const coldStart = extractColdStart(seed);
  const initialMessages = coldStart ? [{ role: "cold-start", content: coldStart }] : [];
  const newSession = {
    id: newSessionId, name: "Part 1", selectedModel: mi,
    temperature: 1, cacheTTL: "1h", thinkingMode: "adaptive", thinkingBudget: getMaxOut(mi) - 1,
    effort: "max", systemPrompt: sysPrompt, stateSeed: seed,
    folderId, campaignId, messages: initialMessages, createdAt: Date.now()
  };

  if (isMigrated(userId)) {
    // Add folder to user meta
    const userMeta = loadUserMeta(userId);
    userMeta.folders = userMeta.folders || [];
    userMeta.folders.push(newFolder);

    // Delete wizard session
    deleteSessionFile(userId, pipeline.wizardSessionId);
    removeSessionMeta(userId, pipeline.wizardSessionId);

    // Create new session
    saveSession(userId, newSession);
    updateSessionMeta(userId, newSession.id, buildSessionMeta(newSession));

    // Set activeId
    userMeta.activeId = newSessionId;
    saveUserMeta(userId, userMeta);
  } else {
    const state = loadUserState(userId);
    if (!state) return res.status(400).json({ error: "No user state" });
    if (!state.folders) state.folders = [];
    state.folders.push(newFolder);

    // Clean up wizard session
    if (state.sessions?.[pipeline.wizardSessionId]) delete state.sessions[pipeline.wizardSessionId];

    // Add new session
    if (!state.sessions) state.sessions = {};
    state.sessions[newSessionId] = newSession;
    state.activeId = newSessionId;

    saveUserState(userId, state);
  }

  // Update campaign activeSessionId
  const cidx = campaigns.findIndex(c => c.id === campaignId);
  if (cidx >= 0) campaigns[cidx].activeSessionId = newSessionId;

  saveCampaigns(userId, campaigns);

  // Mark pipeline approved
  pipeline.status = "approved"; pipeline.approvedAt = new Date().toISOString();
  savePipeline(userId, pipeline);

  res.json({ ok: true, campaignId, folderId, newSessionId, campaignName });
});

// ── Cancel ──
router.post("/cancel", requireAuth, (req, res) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "pipelineId required" });
  const pipeline = loadPipeline(req.session.userId, pipelineId);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  cancelRequests(pipelineId);
  pipeline.status = "cancelled"; pipeline.completedAt = new Date().toISOString(); pipeline.error = "Cancelled by user";
  for (const key of ["step1", "step2", "step3", "step4"]) { if (pipeline[key]?.status === "running") { pipeline[key].status = "cancelled"; pipeline[key].error = "Cancelled"; } }
  savePipeline(req.session.userId, pipeline);
  res.json({ ok: true });
});

// ── Retry (full re-run) ──
router.post("/retry/:id", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const pipeline = loadPipeline(userId, req.params.id);
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
  for (const key of ["step1", "step2", "step3", "step4"]) pipeline[key] = { status: "pending", startedAt: null, completedAt: null, result: null, usage: null, error: null };
  pipeline.status = "running"; pipeline.startedAt = new Date().toISOString(); pipeline.completedAt = null; pipeline.error = null;
  savePipeline(userId, pipeline);
  res.json({ ok: true, pipelineId: pipeline.id });
  runWizardPipeline(userId, pipeline).catch(e => { pipeline.status = "failed"; pipeline.error = `Retry error: ${e.message}`; savePipeline(userId, pipeline); });
});

export default router;
