import fs from "node:fs";
import path from "node:path";

export function createV1ImportFixture(rootDir: string) {
  const userId = "aaaaaaaaaaaaaaaa";
  const campaignId = "bbbbbbbbbbbbbbbb";
  const standaloneSessionId = "session-standalone";
  const campaignSessionId = "session-campaign";
  const folderRootId = "folder-root";
  const folderChildId = "folder-child";
  const customEndpointId = "ep_legacy01";
  const imageId = "img-legacy-1";
  const pipelineRunId = "cccccccccccccccc";
  const sourceDir = path.join(rootDir, "v1-data");
  const userDir = path.join(sourceDir, "users", userId);
  fs.mkdirSync(path.join(userDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(userDir, "campaign_versions", campaignId), { recursive: true });
  fs.mkdirSync(path.join(userDir, "pending"), { recursive: true });
  fs.mkdirSync(path.join(userDir, "pipelines"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "images"), { recursive: true });

  const now = "2026-01-01T00:00:00.000Z";
  const later = "2026-01-02T12:00:00.000Z";
  const latest = "2026-01-03T15:30:00.000Z";

  fs.writeFileSync(path.join(sourceDir, "users.json"), JSON.stringify([{
    id: userId,
    username: "legacy-admin",
    email: "legacy-admin@example.com",
    emailVerified: true,
    agreedToTerms: true,
    trustedDevices: [{ token: "trustedtokenvalue", label: "Desktop", createdAt: now, lastUsed: later }],
    role: "admin",
    passwordHash: "legacy-password-hash",
    createdAt: now,
    updatedAt: latest,
  }], null, 2));

  fs.writeFileSync(path.join(userDir, "meta.json"), JSON.stringify({
    activeId: standaloneSessionId,
    folders: [
      { id: folderRootId, name: "Imported Root", parentId: null, collapsed: false },
      { id: folderChildId, name: "Imported Child", parentId: folderRootId, collapsed: true },
    ],
    fontSize: 16,
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "sessions_meta.json"), JSON.stringify({
    [standaloneSessionId]: {
      id: standaloneSessionId,
      name: "Standalone Legacy",
      selectedModel: "gpt-4.1",
      folderId: folderChildId,
      campaignId: null,
      sessionType: "standard",
      createdAt: now,
      messageCount: 2,
      lastActivity: latest,
    },
    [campaignSessionId]: {
      id: campaignSessionId,
      name: "Campaign Legacy",
      selectedModel: `custom:${customEndpointId}:openrouter/sonnet`,
      folderId: folderRootId,
      campaignId,
      sessionType: "standard",
      createdAt: later,
      messageCount: 1,
      lastActivity: latest,
    },
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "sessions", `${standaloneSessionId}.json`), JSON.stringify({
    id: standaloneSessionId,
    name: "Standalone Legacy",
    selectedModel: "gpt-4.1",
    temperature: 0.7,
    cacheTTL: "off",
    thinkingMode: "off",
    thinkingBudget: null,
    effort: "medium",
    systemPrompt: "Standalone prompt context",
    stateSeed: "Standalone state seed",
    folderId: folderChildId,
    createdAt: now,
    messages: [
      {
        role: "user",
        content: "Review the attached notes.",
        model: "gpt-4.1",
        usage: null,
        timestamp: later,
        files: [
          { name: "notes.md", kind: "text", content: "# Notes\nLegacy import", size: 21 },
          { name: "scene.pdf", kind: "pdf", data: "cGRm", size: 3 },
        ],
      },
      {
        role: "assistant",
        content: "Imported revised prompt",
        model: "gpt-image-1",
        generatedImage: imageId,
        usage: { input: 12, output: 34, cacheRead: 0, cacheCreation: 0 },
        timestamp: latest,
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "sessions", `${campaignSessionId}.json`), JSON.stringify({
    id: campaignSessionId,
    name: "Campaign Legacy",
    selectedModel: `custom:${customEndpointId}:openrouter/sonnet`,
    campaignId,
    folderId: folderRootId,
    createdAt: later,
    messages: [
      {
        role: "user",
        content: "Advance the campaign.",
        model: `custom:${customEndpointId}:openrouter/sonnet`,
        usage: null,
        timestamp: latest,
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "campaigns.json"), JSON.stringify([{
    id: campaignId,
    name: "Imported Campaign",
    folderId: folderRootId,
    systemPrompt: "Campaign prompt",
    stateSeed: "Campaign seed",
    stateSeedVersion: 4,
    updatePromptTemplate: "Update the seed.",
    systemPromptUpdateTemplate: "Update the system prompt.",
    pipelineModel: `custom:${customEndpointId}:openrouter/sonnet`,
    lastUpdated: latest,
    activeSessionId: campaignSessionId,
  }], null, 2));

  fs.writeFileSync(path.join(userDir, "campaign_versions", campaignId, "manifest.json"), JSON.stringify([
    { version: 3, timestamp: later, hasSeed: true, hasSystemPrompt: true },
  ], null, 2));
  fs.writeFileSync(path.join(userDir, "campaign_versions", campaignId, "seed_v3.md"), "Archived seed v3");
  fs.writeFileSync(path.join(userDir, "campaign_versions", campaignId, "system_prompt_v3.md"), "Archived prompt v3");

  fs.writeFileSync(path.join(userDir, "wizard_templates.json"), JSON.stringify({
    exampleStateSeed: "Example state seed",
    exampleSystemPrompt: "Example system prompt",
    seedUpdateTemplate: "Seed update template",
    sysPromptUpdateTemplate: "System prompt update template",
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "apikeys.json"), JSON.stringify({
    anthropic: "anthropic-key",
    deepseek: "",
    google: "",
    openai: "openai-key",
    xai: "",
    zai: "",
    customEndpoints: [{
      id: customEndpointId,
      name: "Legacy Endpoint",
      baseUrl: "https://example.invalid/v1",
      apiKey: "endpoint-key",
      apiFormat: "responses",
      authHeader: "Bearer",
      models: [{ id: "openrouter/sonnet", label: "OpenRouter Sonnet", maxOut: 8192, ctx: 200000 }],
    }],
  }, null, 2));

  fs.writeFileSync(path.join(userDir, "pending", `${standaloneSessionId}.json`), JSON.stringify({
    role: "assistant",
    content: "Pending reply",
    model: "gpt-4.1",
    usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(userDir, "pipelines", `${pipelineRunId}.json`), JSON.stringify({
    id: pipelineRunId,
    campaignId,
    status: "complete",
    summary: "Imported completed pipeline run.",
    requestedAt: later,
    startedAt: latest,
    completedAt: latest,
    updatedAt: latest,
    step1: {
      status: "complete",
      result: "Drafted seed from legacy pipeline",
      error: null,
    },
    step2: {
      status: "complete",
      result: "Validation passed",
      error: null,
      passed: true,
      autoFixStatus: null,
      fixApplyStatus: null,
      fixedSeed: null,
    },
    step3: {
      status: "complete",
      result: "Suggested prompt diff",
      error: null,
      applyStatus: "complete",
      applyError: null,
      appliedResult: "Applied prompt draft",
    },
  }, null, 2));

  fs.writeFileSync(path.join(sourceDir, "images", `${imageId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  return {
    sourceDir,
    userId,
    campaignId,
    standaloneSessionId,
    campaignSessionId,
    folderRootId,
    folderChildId,
    customEndpointId,
    imageId,
    pipelineRunId,
  };
}

export function createV1ImportProductionFixture(rootDir: string) {
  const base = createV1ImportFixture(rootDir);
  const secondUserId = "dddddddddddddddd";
  const secondCampaignId = "eeeeeeeeeeeeeeee";
  const secondSessionId = "session-secondary";
  const secondFolderId = "folder-ops";
  const secondImageId = "img-legacy-2";
  const secondPipelineRunId = "ffffffffffffffff";
  const secondUserDir = path.join(base.sourceDir, "users", secondUserId);
  const now = "2026-01-04T08:00:00.000Z";
  const later = "2026-01-05T09:30:00.000Z";
  const latest = "2026-01-06T11:45:00.000Z";

  fs.mkdirSync(path.join(secondUserDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(secondUserDir, "campaign_versions", secondCampaignId), { recursive: true });
  fs.mkdirSync(path.join(secondUserDir, "pending"), { recursive: true });
  fs.mkdirSync(path.join(secondUserDir, "pipelines"), { recursive: true });

  const usersPath = path.join(base.sourceDir, "users.json");
  const users = JSON.parse(fs.readFileSync(usersPath, "utf8")) as Array<Record<string, unknown>>;
  users.push({
    id: secondUserId,
    username: "legacy-user",
    email: "legacy-user@example.com",
    emailVerified: true,
    agreedToTerms: true,
    trustedDevices: [],
    role: "user",
    passwordHash: "legacy-password-hash-user",
    createdAt: now,
    updatedAt: latest,
  });
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "meta.json"), JSON.stringify({
    activeId: secondSessionId,
    folders: [
      { id: secondFolderId, name: "Operations", parentId: null, collapsed: false },
    ],
    fontSize: 18,
  }, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "sessions_meta.json"), JSON.stringify({
    [secondSessionId]: {
      id: secondSessionId,
      name: "Secondary Legacy",
      selectedModel: "claude-opus-4-6",
      folderId: secondFolderId,
      campaignId: secondCampaignId,
      sessionType: "standard",
      createdAt: now,
      messageCount: 2,
      lastActivity: latest,
    },
  }, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "sessions", `${secondSessionId}.json`), JSON.stringify({
    id: secondSessionId,
    name: "Secondary Legacy",
    selectedModel: "claude-opus-4-6",
    cacheTTL: "1h",
    thinkingMode: "adaptive",
    thinkingBudget: 64000,
    effort: "max",
    campaignId: secondCampaignId,
    folderId: secondFolderId,
    createdAt: now,
    messages: [
      {
        role: "user",
        content: "Reconcile the latest operator notes.",
        model: "claude-opus-4-6",
        usage: null,
        timestamp: later,
      },
      {
        role: "assistant",
        content: "Imported operator summary",
        model: "claude-opus-4-6",
        generatedImage: secondImageId,
        usage: { input: 20, output: 40, cacheRead: 10, cacheCreation: 5 },
        timestamp: latest,
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "campaigns.json"), JSON.stringify([{
    id: secondCampaignId,
    name: "Operations Campaign",
    folderId: secondFolderId,
    systemPrompt: "Operations prompt",
    stateSeed: "Operations seed",
    stateSeedVersion: 2,
    updatePromptTemplate: "Update the operations seed.",
    systemPromptUpdateTemplate: "Update the operations system prompt.",
    pipelineModel: "claude-opus-4-6",
    lastUpdated: latest,
    activeSessionId: secondSessionId,
  }], null, 2));

  fs.writeFileSync(path.join(secondUserDir, "campaign_versions", secondCampaignId, "manifest.json"), JSON.stringify([
    { version: 1, timestamp: later, hasSeed: true, hasSystemPrompt: true },
  ], null, 2));
  fs.writeFileSync(path.join(secondUserDir, "campaign_versions", secondCampaignId, "seed_v1.md"), "Archived operations seed v1");
  fs.writeFileSync(path.join(secondUserDir, "campaign_versions", secondCampaignId, "system_prompt_v1.md"), "Archived operations prompt v1");

  fs.writeFileSync(path.join(secondUserDir, "wizard_templates.json"), JSON.stringify({
    exampleStateSeed: "Operations example state seed",
    exampleSystemPrompt: "Operations example system prompt",
    seedUpdateTemplate: "Operations seed update template",
    sysPromptUpdateTemplate: "Operations system prompt update template",
  }, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "apikeys.json"), JSON.stringify({
    anthropic: "anthropic-key-user",
    deepseek: "",
    google: "google-key-user",
    openai: "",
    xai: "",
    zai: "",
    customEndpoints: [],
  }, null, 2));

  fs.writeFileSync(path.join(secondUserDir, "pipelines", `${secondPipelineRunId}.json`), JSON.stringify({
    id: secondPipelineRunId,
    campaignId: secondCampaignId,
    status: "failed",
    summary: "Imported failed pipeline run.",
    error: "Imported failed pipeline run.",
    requestedAt: later,
    startedAt: latest,
    completedAt: latest,
    updatedAt: latest,
    retriedFromStep: "validation",
    step1: {
      status: "complete",
      result: "Drafted operations seed",
      error: null,
    },
    step2: {
      status: "failed",
      result: "Validation failed",
      error: "Schema mismatch",
      passed: false,
      autoFixStatus: "failed",
      autoFixError: "Legacy fix failed",
      fixEdits: "REPLACE stale node",
      fixApplyStatus: null,
      fixedSeed: null,
    },
    step3: {
      status: "complete",
      result: "Suggested operations diff",
      error: null,
      applyStatus: "pending",
      applyError: null,
      appliedResult: null,
    },
  }, null, 2));

  fs.writeFileSync(path.join(base.sourceDir, "images", `${secondImageId}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  return {
    ...base,
    secondUserId,
    secondCampaignId,
    secondSessionId,
    secondFolderId,
    secondImageId,
    secondPipelineRunId,
  };
}
