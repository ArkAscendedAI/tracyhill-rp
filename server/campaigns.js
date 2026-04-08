// ═══════════════════════════════════════════════════════════
// CAMPAIGN MANAGEMENT — CRUD for campaign documents
// ═══════════════════════════════════════════════════════════

import { Router } from "express";
import crypto from "crypto";
import { requireAuth, loadCampaigns, saveCampaigns, loadCampaignVersions, loadCampaignVersionFile, archiveCampaignVersion } from "./shared.js";

const router = Router();

// ── List all campaigns ──
router.get("/", requireAuth, (req, res) => {
  const campaigns = loadCampaigns(req.session.userId);
  // Return lightweight list (don't send full document bodies)
  res.json(campaigns.map(c => ({
    id: c.id, name: c.name, folderId: c.folderId, stateSeedVersion: c.stateSeedVersion,
    pipelineModel: c.pipelineModel, lastUpdated: c.lastUpdated, activeSessionId: c.activeSessionId,
    hasSystemPrompt: !!c.systemPrompt, hasStateSeed: !!c.stateSeed,
    hasUpdatePrompt: !!c.updatePromptTemplate, hasSystemPromptUpdatePrompt: !!c.systemPromptUpdateTemplate
  })));
});

// ── Get single campaign (full documents) ──
router.get("/:id", requireAuth, (req, res) => {
  const campaigns = loadCampaigns(req.session.userId);
  const c = campaigns.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found" });
  res.json(c);
});

// ── Create campaign ──
router.post("/", requireAuth, (req, res) => {
  const { name, folderId, systemPrompt, stateSeed, stateSeedVersion, updatePromptTemplate, systemPromptUpdateTemplate, pipelineModel } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Campaign name required" });

  const campaigns = loadCampaigns(req.session.userId);
  const campaign = {
    id: crypto.randomBytes(8).toString("hex"),
    name: name.trim(),
    folderId: folderId || null,
    systemPrompt: systemPrompt || "",
    stateSeed: stateSeed || "",
    stateSeedVersion: stateSeedVersion || 0,
    updatePromptTemplate: updatePromptTemplate || "",
    systemPromptUpdateTemplate: systemPromptUpdateTemplate || "",
    pipelineModel: pipelineModel || "claude-opus-4-6",
    lastUpdated: new Date().toISOString(),
    activeSessionId: null
  };
  campaigns.push(campaign);
  saveCampaigns(req.session.userId, campaigns);
  res.json(campaign);
});

// ── Update campaign ──
router.put("/:id", requireAuth, (req, res) => {
  const campaigns = loadCampaigns(req.session.userId);
  const idx = campaigns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Campaign not found" });

  const allowed = ["name", "folderId", "systemPrompt", "stateSeed", "stateSeedVersion", "updatePromptTemplate", "systemPromptUpdateTemplate", "pipelineModel", "activeSessionId"];
  const stringFields = new Set(["name", "folderId", "systemPrompt", "stateSeed", "updatePromptTemplate", "systemPromptUpdateTemplate", "pipelineModel", "activeSessionId"]);
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (stringFields.has(key) && typeof req.body[key] !== "string" && req.body[key] !== null) continue; // type-check strings
      if (key === "stateSeedVersion" && typeof req.body[key] !== "number") continue;
      campaigns[idx][key] = req.body[key];
    }
  }
  campaigns[idx].lastUpdated = new Date().toISOString();
  saveCampaigns(req.session.userId, campaigns);
  res.json(campaigns[idx]);
});

// ── Delete campaign (record only — does NOT delete folder or sessions) ──
router.delete("/:id", requireAuth, (req, res) => {
  const campaigns = loadCampaigns(req.session.userId);
  const idx = campaigns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Campaign not found" });
  campaigns.splice(idx, 1);
  saveCampaigns(req.session.userId, campaigns);
  res.json({ ok: true });
});

// ── Version history ──
router.get("/:id/versions", requireAuth, (req, res) => {
  res.json(loadCampaignVersions(req.session.userId, req.params.id));
});

router.get("/:id/versions/:filename", requireAuth, (req, res) => {
  const content = loadCampaignVersionFile(req.session.userId, req.params.id, req.params.filename);
  if (content === null) return res.status(404).json({ error: "Version file not found" });
  res.type("text/markdown").send(content);
});

router.post("/:id/restore", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { version, restoreSeed, restoreSystemPrompt } = req.body || {};
  if (version === undefined || version === null) return res.status(400).json({ error: "version required" });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return res.status(400).json({ error: "version must be a non-negative integer" });

  const campaigns = loadCampaigns(userId);
  const cidx = campaigns.findIndex(c => c.id === req.params.id);
  if (cidx === -1) return res.status(404).json({ error: "Campaign not found" });

  // Archive current version before restoring (so the restore itself is reversible)
  archiveCampaignVersion(userId, req.params.id, campaigns[cidx].stateSeedVersion, campaigns[cidx].stateSeed, campaigns[cidx].systemPrompt);

  const seedContent = restoreSeed !== false ? loadCampaignVersionFile(userId, req.params.id, `seed_v${version}.md`) : null;
  const promptContent = restoreSystemPrompt ? loadCampaignVersionFile(userId, req.params.id, `system_prompt_v${version}.md`) : null;

  if (seedContent) { campaigns[cidx].stateSeed = seedContent; campaigns[cidx].stateSeedVersion = version; }
  if (promptContent) { campaigns[cidx].systemPrompt = promptContent; }
  campaigns[cidx].lastUpdated = new Date().toISOString();
  saveCampaigns(userId, campaigns);

  res.json({ ok: true, restoredVersion: version, restoredSeed: !!seedContent, restoredPrompt: !!promptContent });
});

export default router;
