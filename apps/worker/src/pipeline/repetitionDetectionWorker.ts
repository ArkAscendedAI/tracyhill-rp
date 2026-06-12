import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { V4_REPETITION_DETECTION_PROMPT } from "./pipelinePrompts";
import { withRetry } from "./retryHelper";

export class RepetitionDetectionWorker {
  private readonly logger = createLogger("repetition-detection-worker");
  private readonly campaigns;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.campaigns = new CampaignRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", claudeCodeBridgeUrl: "", claudeCodeBridgeSecret: "", deepseekApiKey: "", googleApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "" };
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null }) {
    const now = new Date().toISOString();
    try {
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }

      const sessionId = run.sessionId;
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for repetition detection", null); return; }

      const allMessages = this.messages.listForSession(run.userId, sessionId).filter(m => m.role !== "cold-start");
      const recentTurns = allMessages.slice(-30).map(m => `[${m.role}]: ${m.content.trim()}`).join("\n\n");

      if (!recentTurns.trim()) {
        const doneAt = new Date().toISOString();
        this.runs.markCompleted(run.id, doneAt, "No messages to analyze", null);
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      const existingRules = this.getExistingRules(run.userId, run.campaignId);

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, campaign.pipelineModelId)?.id ?? campaign.pipelineModelId;

      const prompt = [
        V4_REPETITION_DETECTION_PROMPT, "",
        "<transcript_window>", recentTurns, "</transcript_window>", "",
        "<existing_anti_repetition_rules>", existingRules || "None.", "</existing_anti_repetition_rules>",
      ].join("\n");

      let responseText = "";
      let inputTokens = 0, outputTokens = 0;
      await withRetry(() => runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt, attachments: [] }],
        temperature: 0,
        thinkingMode: "adaptive",
        effort: "max",
        requestId: `repetition-detection-${run.id}`,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: (result) => {
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
        },
      }), () => { responseText = ""; });

      const rawRules = this.parseRules(responseText);
      if (rawRules.length > 0) {
        const defaults = campaign.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson) : {};
        const maxRules = (typeof defaults.maxAntiRepetitionRules === "number" && defaults.maxAntiRepetitionRules > 0) ? defaults.maxAntiRepetitionRules : 80;
        const archiveAfter = (typeof defaults.antiRepArchiveAfter === "number" && defaults.antiRepArchiveAfter > 0) ? defaults.antiRepArchiveAfter : 5;

        const previous = this.getPreviousRules(run.userId, run.campaignId);
        const previousArchive = this.getArchivedRules(run.userId, run.campaignId);
        const deduped = deduplicateRules(rawRules);
        const tracked = trackZeroStreak(deduped, previous);
        const { active, archived: newlyArchived } = archiveExpired(tracked, archiveAfter);
        const { kept, overflow } = enforceCap(active, maxRules);
        const fullArchive = [...previousArchive, ...newlyArchived, ...overflow];
        this.applyRulesWithArchive(run.userId, run.campaignId, kept, fullArchive);
        this.logger.info({ raw: rawRules.length, deduped: deduped.length, active: kept.length, archived: newlyArchived.length + overflow.length }, "post-processed anti-repetition rules");
      }

      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt, `Processed ${rawRules.length} anti-repetition rules`, JSON.stringify({ rules: rawRules.length, usage: { modelId, inputTokens, outputTokens } }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "repetition detection failed", null);
    }
  }

  private getExistingRules(userId: string, campaignId: string): string | null {
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign?.contextDefaultsJson) return null;
    try {
      const defaults = JSON.parse(campaign.contextDefaultsJson);
      return defaults.antiRepetitionRules ? JSON.stringify(defaults.antiRepetitionRules) : null;
    } catch { return null; }
  }

  private getPreviousRules(userId: string, campaignId: string): any[] { // LLM-generated JSON
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign?.contextDefaultsJson) return [];
    try {
      const defaults = JSON.parse(campaign.contextDefaultsJson);
      return Array.isArray(defaults.antiRepetitionRules) ? defaults.antiRepetitionRules : [];
    } catch { return []; }
  }

  private getArchivedRules(userId: string, campaignId: string): any[] { // LLM-generated JSON
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign?.contextDefaultsJson) return [];
    try {
      const defaults = JSON.parse(campaign.contextDefaultsJson);
      return Array.isArray(defaults.archivedAntiRepetitionRules) ? defaults.archivedAntiRepetitionRules : [];
    } catch { return []; }
  }

  private parseRules(text: string): any[] { // LLM-generated JSON
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r: any) => r && typeof r.pattern === "string" && typeof r.replacement_guidance === "string");
    } catch { return []; }
  }

  private applyRulesWithArchive(userId: string, campaignId: string, rules: any[], archived: any[]) { // LLM-generated JSON
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) return;
    const existing = campaign.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson) : {};
    existing.antiRepetitionRules = rules;
    existing.archivedAntiRepetitionRules = archived;
    this.campaigns.updateCampaign(userId, campaignId, { contextDefaultsJson: JSON.stringify(existing), updatedAt: new Date().toISOString() });
  }
}

function safeParseJson(v: string): Record<string, unknown> {
  try { return JSON.parse(v); } catch { return {}; }
}

function normalizePattern(pattern: string): string {
  const stripped = pattern.split(/\s+[—–-]\s+e\.g\./)[0] ?? pattern;
  return stripped.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function wordSet(text: string): Set<string> {
  return new Set(text.split(" ").filter(w => w.length >= 3));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function rulePriority(r: any): number { // LLM-generated JSON
  const freq = r.frequency ?? 0;
  const typeScore = r.rule_type === "ban" ? 3 : r.rule_type === "limit" ? 2 : 1;
  const statusScore = r.status === "dormant" ? 0 : 1;
  return statusScore * 10000 + typeScore * 1000 + freq;
}

function deduplicateRules(rules: any[]): any[] { // LLM-generated JSON
  const normalized = rules.map(r => ({ rule: r, norm: normalizePattern(r.pattern), words: wordSet(normalizePattern(r.pattern)) }));
  const dropped = new Set<number>();
  for (let i = 0; i < normalized.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < normalized.length; j++) {
      if (dropped.has(j)) continue;
      if (jaccardSimilarity(normalized[i]!.words, normalized[j]!.words) > 0.55) {
        const keepI = rulePriority(normalized[i]!.rule) >= rulePriority(normalized[j]!.rule);
        dropped.add(keepI ? j : i);
        if (!keepI) break;
      }
    }
  }
  return normalized.filter((_, idx) => !dropped.has(idx)).map(n => n.rule);
}

function trackZeroStreak(rules: any[], previous: any[]): any[] { // LLM-generated JSON
  const prevMap = new Map<string, any>(); // LLM-generated JSON
  for (const r of previous) {
    const norm = normalizePattern(r.pattern);
    const words = wordSet(norm);
    prevMap.set(norm, { rule: r, words });
  }
  return rules.map(r => {
    const norm = normalizePattern(r.pattern);
    const words = wordSet(norm);
    let prev: any = prevMap.get(norm)?.rule; // LLM-generated JSON
    if (!prev) {
      for (const [, entry] of prevMap) {
        if (jaccardSimilarity(words, entry.words) > 0.8) { prev = entry.rule; break; }
      }
    }
    const freq = r.frequency ?? 0;
    const prevStreak = prev?.zero_streak ?? 0;
    return { ...r, zero_streak: freq === 0 ? prevStreak + 1 : 0 };
  });
}

function archiveExpired(rules: any[], threshold: number): { active: any[]; archived: any[] } { // LLM-generated JSON
  const active: any[] = []; // LLM-generated JSON
  const archived: any[] = []; // LLM-generated JSON
  for (const r of rules) {
    if ((r.zero_streak ?? 0) >= threshold) archived.push({ ...r, archived_at: new Date().toISOString() });
    else active.push(r);
  }
  return { active, archived };
}

function enforceCap(rules: any[], max: number): { kept: any[]; overflow: any[] } { // LLM-generated JSON
  if (rules.length <= max) return { kept: rules, overflow: [] };
  const sorted = [...rules].sort((a, b) => rulePriority(b) - rulePriority(a));
  return { kept: sorted.slice(0, max), overflow: sorted.slice(max).map(r => ({ ...r, archived_at: new Date().toISOString() })) };
}
