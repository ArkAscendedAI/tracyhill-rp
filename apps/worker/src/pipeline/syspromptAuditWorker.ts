import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CampaignVersionRepository } from "../../../api/src/domain/campaigns/campaignVersionRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { createId } from "../../../api/src/lib/ids";
import { V4_SYSPROMPT_UPDATE_PROMPT } from "./pipelinePrompts";
import { withRetry } from "./retryHelper";

export class SyspromptAuditWorker {
  private readonly logger = createLogger("sysprompt-audit-worker");
  private readonly campaigns;
  private readonly versions;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly lorebook;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.campaigns = new CampaignRepository(db);
    this.versions = new CampaignVersionRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.lorebook = new LorebookRepository(db);
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
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for sysprompt audit", null); return; }

      const allMessages = this.messages.listForSession(run.userId, sessionId).filter(m => m.role !== "cold-start");
      const recentTurns = allMessages.slice(-20).map(m => `[${m.role}]: ${m.content.trim()}`).join("\n\n");

      if (!recentTurns.trim()) {
        const doneAt = new Date().toISOString();
        this.runs.markCompleted(run.id, doneAt, "No messages to audit", null);
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, campaign.pipelineModelId)?.id ?? campaign.pipelineModelId;

      const prompt = [
        V4_SYSPROMPT_UPDATE_PROMPT, "",
        "<current_system_prompt>", campaign.systemPrompt, "</current_system_prompt>", "",
        "<lorebook_operations>", "No lorebook changes (standalone audit).", "</lorebook_operations>", "",
        "<new_transcript_window>", recentTurns, "</new_transcript_window>", "",
        "<analysis_report>", "Automated periodic system prompt review.", "</analysis_report>",
      ].join("\n");

      let responseText = "";
      let inputTokens = 0, outputTokens = 0;
      await withRetry(() => runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt, attachments: [] }],
        temperature: 0,
        thinkingMode: "adaptive",
        effort: "max",
        requestId: `sysprompt-audit-${run.id}`,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: (result) => {
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
        },
      }), () => { responseText = ""; });

      const noChanges = /^\s*(NO_CHANGES_NEEDED|no changes needed\.?|no changes\.?)\s*$/i.test(responseText);
      const doneAt = new Date().toISOString();

      if (noChanges) {
        this.runs.markCompleted(run.id, doneAt, "System prompt audit — no changes needed", JSON.stringify({ noChanges: true, usage: { modelId, inputTokens, outputTokens } }));
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      // Safety guard (2026-06-07): never persist a degenerate response as the
      // system prompt. During the 4.8-bridge outage the model "response" was the
      // bridge's injected error string (e.g. "*[error: agent stream ended
      // without result event]*"), and the old code saved it verbatim — wiping
      // the Buffy and Red Rising campaign prompts. Reject error-shaped output or
      // an implausibly short rewrite (< 50% of the current prompt); the run
      // fails and the live prompt is left untouched.
      const candidate = responseText.trim();
      const looksLikeError =
        /\*?\[error:/i.test(candidate) ||
        /agent stream ended without result event/i.test(candidate) ||
        /Claude Code (process exited|returned an error)/i.test(candidate);
      const tooShort = candidate.length < Math.floor(campaign.systemPrompt.length * 0.5);
      if (looksLikeError || tooShort) {
        const reason = looksLikeError
          ? "output looks like an error message"
          : `output too short (${candidate.length} chars < 50% of current ${campaign.systemPrompt.length})`;
        this.runs.markFailed(run.id, doneAt, `sysprompt audit rejected — ${reason}`, null);
        return;
      }

      // Atomic: archive the prior version AND bump the live campaign in one
      // transaction so we can't end up with a version row pointing at the
      // wrong prompt if the second write fails.
      this.campaigns.bumpVersionWithArchive(run.userId, run.campaignId, {
        archive: {
          id: createId(), campaignId: campaign.id, userId: run.userId,
          version: campaign.version, systemPrompt: campaign.systemPrompt,
          createdAt: doneAt, label: null,
        },
        nextSystemPrompt: candidate,
        nextVersion: campaign.version + 1,
        updatedAt: doneAt,
      });

      this.runs.markCompleted(run.id, doneAt, `System prompt updated to v${campaign.version + 1}`, JSON.stringify({ noChanges: false, usage: { modelId, inputTokens, outputTokens } }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "sysprompt audit failed", null);
    }
  }
}
