import { randomUUID } from "node:crypto";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";
import { parseFirstJson, type ChatRuntime } from "@tracyhill-rp/provider-runtime";
import {
  antagonistSchemeSchema,
  clampDriveSeedText,
  extractWizardPlayerCharacter,
  lintWizardCorpusEntry,
  lintWizardCharacterCapability,
  lintWizardSystemPrompt,
  normalizeCorpusRetrievalFields,
  normalizeDriveSeedList,
  normalizeWizardCorpusName,
  splitBroadRetrievalKeys,
  stampCanonicalPcProtectionBlock,
  stripWizardPcProtectionSections,
  type AntagonistScheme,
  type WizardAutoCorrection,
  type WizardLintFinding,
} from "@tracyhill-rp/contracts";

import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { sanitizeCreateTag } from "../../../api/src/domain/context/lorebookTags";
import { normalizeKeyList } from "../../../api/src/domain/context/lorebookKeys";
import { withRetry } from "../pipeline/retryHelper";
import { WizardRunRepository, createDefaultWizardRunDetails, parseWizardRunDetails } from "../../../api/src/domain/wizard/wizardRunRepository";
import { WizardTemplateRepository } from "../../../api/src/domain/wizard/wizardTemplateRepository";
import {
  WIZARD_V3_SYSTEM_PROMPT,
  WIZARD_V3_CORPUS_PROMPT,
} from "./wizardV3Prompts";
import type { LorebookCorpusEntry, StoredWizardImportSource } from "../../../api/src/domain/wizard/wizardRunRepository";
import {
  appendCharacterSections,
  batchBySize,
  formatEntryIndex,
  formatLorebookForPrompt,
  importAdvisories,
  importCharacterPrompt,
  importedCorpusEntry,
  importRulesPrompt,
  importSortPrompt,
  importSystemPromptNote,
  lorebookBudgetChars,
  parseCharacterResponse,
  parseRulesResponse,
  parseSortResponse,
  planImportedCorpus,
  type ImportSort,
} from "./lorebookImport";

export type WizardWorkerOptions = {
  runtime?: ChatRuntime | null;
  runtimeDefaults?: ProviderRuntimeDefaults;
};

type AlignedSystemPrompt = {
  draft: string;
  playerCharacterName: string;
  autoCorrections: WizardAutoCorrection[];
  lintResidue: WizardLintFinding[];
};

// Wall-clock heartbeat cadence while a wizard run's undeadlined streams are
// in flight — so recoverOrphanedRunningJobs at the next boot is the only reaper.
const WIZARD_HEARTBEAT_MS = 45_000;

/**
 * The generated prompt must still carry campaign-specific text after the
 * canonical Section A stamp. The model is shown the owner's
 * example prompt — for any campaign created after the canonical block landed
 * that example BEGINS with `## Section A: …` — and if it mirrors that heading,
 * the strip removes everything until the next `## ` heading. A draft reduced
 * to the canonical block alone passes every lint (exactly one canonical block,
 * no interaction mechanics) and used to complete approval-ready with
 * `lintResidue: []`. Fail the run instead; the user regenerates. Exported for
 * tests.
 */
export function assertCampaignBodySurvived(stampedPrompt: string, stage: "generation" | "alignment"): void {
  const body = stripWizardPcProtectionSections(stampedPrompt).trim();
  if (body.length === 0) {
    throw new Error(`wizard system prompt has no campaign-specific body after ${stage} — the model output was empty or consisted only of Section A (retry the wizard)`);
  }
}

type AlignedCorpus = {
  entries: LorebookCorpusEntry[];
  autoCorrections: WizardAutoCorrection[];
  lintResidue: WizardLintFinding[];
};

type AlignOptions = {
  // An entry whose lint repair cannot be verified is excluded, unless this says to keep it: imported text belongs to
  // the owner, so it stays as written and the finding stays visible in the review (SillyTavern import).
  keepUnrepaired?: (entry: LorebookCorpusEntry) => boolean;
};

/** The deterministic system prompt the explicit mock runtime (MOCK_PROVIDER) returns. */
function stubSystemPrompt(campaignName: string, playerCharacterName = "the player character"): string {
  return [
    `PLAYER_CHARACTER: ${playerCharacterName}`,
    "",
    `## Section B: Content Rating & Tone Declaration\nHonor the tone established for ${campaignName}.`,
    "",
    "## Section C: World Stakes & Consequence Tone\nConsequences remain grounded in established canon and compound naturally.",
    "",
    "## Section D: Style Discipline\nUse concrete, scene-specific prose and avoid stock dramatic constructions.",
    "",
    "## Section E: Response Economy\nMatch response scope to the dramatic beat and trust the reader.",
    "",
    "## Section F: Information Boundaries\nKeep every character inside their established knowledge silo.",
    "",
    `## Section G: Campaign Signature\n${campaignName} moves through consequence, pressure, and earned revelation.`,
  ].join("\n");
}

/** Runs `work` over `items` with at most `limit` in flight; the first failure stops new work and is rethrown. */
async function runLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === null && next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch (error) { if (failure === null) failure = error; }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

export class WizardWorker {
  private readonly logger = createLogger("tracyhill-rp-v2-worker");
  private readonly templates;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime: ChatRuntime | null | undefined;
  private readonly mockRuntime: boolean;
  private readonly runtimeDefaults;
  private readonly activeRuns = new Map<string, AbortController>();
  private ticking = false;

  constructor(dbFile: string, options?: WizardWorkerOptions) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.templates = new WizardTemplateRepository(db);
    this.runs = new WizardRunRepository(db);
    // Split-topology orphan recovery, same reasoning as the
    // pipeline worker: the dedicated worker owns wizard runs, so it recovers
    // them at boot; createApp covers only the inline topology.
    // Non-fatal, never silent.
    try { this.runs.recoverOrphanedRunningJobs(); } catch (err) {
      this.logger.error({ err }, "wizard boot orphan recovery failed — running rows from a previous process were NOT requeued");
      recordSystemEvent({
        userId: "__system__", source: "wizard", severity: "error",
        message: `wizard boot orphan recovery failed — in-flight wizard runs from the previous process were not requeued: ${err instanceof Error ? err.message : String(err)}`,
        details: { pid: process.pid },
      });
    }
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    // `null` is the EXPLICIT mock runtime (MOCK_PROVIDER=1 via createApp /
    // index.ts) and the only case where the deterministic stub output below is
    // legitimate. `undefined` means "build the user's runtime" — and if the
    // user has no provider key that yields null too, which must FAIL the run,
    // never ship approval-ready stub content.
    this.mockRuntime = options?.runtime === null;
    this.runtime = options?.runtime;
    this.runtimeDefaults = options?.runtimeDefaults ?? {
      anthropicApiKey: "",
      runnerUrl: "", runnerSecret: "",
      deepseekApiKey: "",
      fireworksApiKey: "",
      gmicloudApiKey: "",
      googleApiKey: "",
      moonshotApiKey: "",
      openaiApiKey: "",
      xaiApiKey: "",
      xiaomiApiKey: "",
      zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" 
    };
  }

  private stopped = false;
  stop() { this.stopped = true; }
  get activeRunCount() { return this.activeRuns.size; }

  kick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    queueMicrotask(async () => {
      try {
        await this.drain();
      } catch (err) {
        // Survive any drain failure under INLINE_WORKERS=1; the next kick() retries.
        this.logger.error({ err }, "wizard drain failed");
      } finally {
        this.ticking = false;
      }
    });
  }

  async drain() {
    while (await this.runNext()) { /* keep draining */ }
  }

  cancelRun(runId: string) {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runNext() {
    if (this.stopped) return false;
    const next = this.runs.findNextQueued();
    if (!next) return false;
    const startedAt = new Date().toISOString();
    if (!this.runs.markRunning(next.id, startedAt)) return true;
    let details = parseWizardRunDetails(next.detailsJson);
    const abortController = new AbortController();
    this.activeRuns.set(next.id, abortController);
    const stopWatching = this.watchForCancellation(next.userId, next.id, abortController);
    // Wall-clock heartbeat: wizard calls run UNDEADLINED
    // (2026-08-09), and updatedAt otherwise moves only when a step
    // persists — so a legitimate >60-min corpus generation looked dead to the
    // 60-min stale-lock sweep. Same shape as the audit's streaming beats: a
    // live process beats while its streams run, and the sweep reaps only
    // processes that actually died.
    const heartbeatTimer = setInterval(() => {
      try { this.runs.heartbeat(next.id); } catch (err) { this.logger.warn({ err, runId: next.id }, "wizard heartbeat failed"); }
    }, WIZARD_HEARTBEAT_MS);
    try {
      details = {
        ...createDefaultWizardRunDetails(details.review.campaignName, details.review.brief, details.review.wizardTranscript),
        review: {
          ...createDefaultWizardRunDetails(details.review.campaignName, details.review.brief, details.review.wizardTranscript).review,
          campaignName: details.review.campaignName,
          brief: details.review.brief,
          wizardTranscript: details.review.wizardTranscript,
          // Preserve the source wizard session id through the worker rebuild —
          // approveRun now resolves the session to destroy ONLY from
          // this field (the findActiveWizardForUser fallback was dropped), so
          // losing it here would leak the wizard session post-approval.
          wizardSessionId: details.review.wizardSessionId,
          retriedFromRunId: details.review.retriedFromRunId,
          // A lorebook import keeps its summary and the player character the owner named.
          importSummary: details.review.importSummary,
          ...(details.source ? { playerCharacterName: details.review.playerCharacterName } : {}),
        },
        source: details.source ?? null,
      };
      const templates = this.templates.ensureForUser(next.userId, startedAt);
      const modelConfig = resolveChatModelConfig(this.customEndpoints, next.userId, next.modelId);
      const modelId = modelConfig?.id ?? getDefaultChatModelId();
      const importSource = details.source ?? null;
      let importUnsorted = 0;
      const runtime = this.runtime !== undefined ? this.runtime : createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, next.userId, this.runtimeDefaults);

      // Generate system prompt + lorebook corpus in parallel
      details.steps.systemPrompt.status = "running";
      details.steps.lorebookCorpus.status = "running";
      this.persist(next.id, details);
      this.runs.heartbeat(next.id); // liveness before the long parallel streams

      const systemPromptPromise = (importSource
        ? this.generateImportSystemPrompt(runtime, modelId, details.review.campaignName, importSource, details.review.playerCharacterName, templates.exampleSystemPrompt, modelConfig?.ctx ?? 128_000, abortController.signal)
        : this.generateSystemPrompt(runtime, modelId, details.review.campaignName, details.review.wizardTranscript, templates.exampleSystemPrompt, abortController.signal))
        .then(result => {
          details.steps.systemPrompt = { status: "completed", result: result.draft, error: null };
          details.review.systemPromptDraft = result.draft;
          details.review.playerCharacterName = result.playerCharacterName;
          details.review.autoCorrections.push(...result.autoCorrections);
          details.review.lintResidue.push(...result.lintResidue);
          this.persist(next.id, details);
        })
        .catch((error: unknown) => {
          details.steps.systemPrompt = { status: "failed", result: null, error: error instanceof Error ? error.message : "system prompt generation failed" };
          this.persist(next.id, details);
          throw error;
        });

      // Progress of a lorebook import's batches, written at most once a second while it runs.
      let lastProgressAt = 0;
      const reportProgress = (text: string) => {
        details.steps.lorebookCorpus.progress = text;
        const now = Date.now();
        if (now - lastProgressAt < 1000) return;
        lastProgressAt = now;
        this.persist(next.id, details);
      };
      const corpusPromise = (importSource
        ? this.convertImportedLorebook(runtime, modelId, importSource, details.review.playerCharacterName, modelConfig?.ctx ?? 128_000, modelConfig?.maxOut ?? 8192, reportProgress, abortController.signal)
          .then((result) => { importUnsorted = result.unsorted; return result; })
        : this.generateLorebookCorpus(runtime, modelId, details.review.campaignName, details.review.wizardTranscript, abortController.signal))
        .then(result => {
          // An import's step result is a count: the entries themselves are the review's corpus, and the list the
          // browser polls once a second while a run is active stays small.
          details.steps.lorebookCorpus = { status: "completed", result: importSource ? `${result.entries.length} entries` : JSON.stringify(result.entries), error: null, progress: null };
          details.review.lorebookCorpusDraft = result.entries;
          details.review.autoCorrections.push(...result.autoCorrections);
          details.review.lintResidue.push(...result.lintResidue);
          this.persist(next.id, details);
        })
        .catch((error: unknown) => {
          details.steps.lorebookCorpus = { status: "failed", result: null, error: error instanceof Error ? error.message : "lorebook corpus generation failed" };
          this.persist(next.id, details);
          throw error;
        });

      try {
        await Promise.all([systemPromptPromise, corpusPromise]);
      } catch (error) {
        await Promise.allSettled([systemPromptPromise, corpusPromise]);
        if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        const message = error instanceof Error ? error.message : "wizard generation failed";
        this.runs.markFailed(next.id, new Date().toISOString(), message, JSON.stringify(details));
        return true;
      }

      // Named player-authority pass: the corpus was linted before
      // the prompt side resolved the name. Repairs/excludes exactly like the
      // alignment loop; the review dialog shows every correction.
      const named = await this.alignCorpusForPlayerCharacter(runtime, modelId, details.review.lorebookCorpusDraft ?? [], details.review.playerCharacterName, abortController.signal, importSource ? { keepUnrepaired: (entry) => entry.origin?.kind === "imported" } : {});
      if (named.autoCorrections.length > 0 || named.lintResidue.length > 0) {
        details.review.lorebookCorpusDraft = named.entries;
        details.steps.lorebookCorpus.result = importSource ? `${named.entries.length} entries` : JSON.stringify(named.entries);
        details.review.autoCorrections.push(...named.autoCorrections);
        details.review.lintResidue.push(...named.lintResidue);
      }

      // Structural-adequacy pass. Runs HERE rather than inside alignCorpus because
      // the corpus and the system prompt generate in parallel, and the player
      // character's name only exists after the prompt side resolves — linting the
      // PC for "no red lines" every run would be pure noise.
      //
      // Surfaces characters generated without red lines, without leverage or a
      // secret, or with a scheme lacking real steps and a target. Reported as
      // residue rather than auto-corrected: the fix is regeneration with the
      // capability requirements in front of the model, not a patched string. The
      // grit dials govern play and are reversible; a corpus is not, so this is the
      // last moment softness is free to fix.
      for (const entry of details.review.lorebookCorpusDraft ?? []) {
        // An imported entry that was off in SillyTavern stays off, and nothing runs a character whose entry is off.
        if (entry.activation?.enabled === false) continue;
        details.review.lintResidue.push(...lintWizardCharacterCapability(entry, details.review.playerCharacterName));
      }
      if (importSource) details.review.lintResidue.push(...importAdvisories(importSource, details.review.lorebookCorpusDraft ?? [], importUnsorted));
      this.persist(next.id, details);

      const completedAt = new Date().toISOString();
      const modelLabel = resolveChatModelConfig(this.customEndpoints, next.userId, modelId)?.label ?? modelId;
      const summary = `Wizard review prepared for ${details.review.campaignName} using ${modelLabel}.`;
      this.runs.markCompleted(next.id, completedAt, summary, JSON.stringify(details));
      this.logger.info({ runId: next.id, status: "completed" }, "wizard run completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "wizard worker failed";
      const canceled = abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (canceled) {
        this.runs.markCanceled(next.id, new Date().toISOString(), "wizard run canceled", JSON.stringify(details));
        this.logger.info({ runId: next.id, status: "canceled" }, "wizard run canceled");
      } else {
        this.runs.markFailed(next.id, new Date().toISOString(), message, JSON.stringify(details));
        this.logger.error({ runId: next.id, error: message }, "wizard run failed");
      }
    } finally {
      clearInterval(heartbeatTimer);
      stopWatching();
      this.activeRuns.delete(next.id);
    }
    return true;
  }

  private watchForCancellation(userId: string, runId: string, controller: AbortController) {
    const interval = setInterval(() => {
      try {
        const current = this.runs.findById(userId, runId);
        if (current?.status === "canceled") controller.abort();
      } catch (err) {
        this.logger.warn({ err, runId }, "cancellation poll failed");
      }
    }, 250);
    return () => clearInterval(interval);
  }

  private persist(runId: string, details: ReturnType<typeof createDefaultWizardRunDetails>) {
    this.runs.updateRun(runId, {
      detailsJson: JSON.stringify(details),
      updatedAt: new Date().toISOString(),
    });
  }

  private async generateSystemPrompt(runtime: ChatRuntime | null, modelId: string, campaignName: string, wizardTranscript: string, exampleSystemPrompt: string, signal?: AbortSignal): Promise<AlignedSystemPrompt> {
    const prompt = [
      WIZARD_V3_SYSTEM_PROMPT,
      "",
      `<campaign_name>\n${campaignName}\n</campaign_name>`,
      "",
      `<wizard_conversation>\n${wizardTranscript}\n</wizard_conversation>`,
      "",
      `<example_system_prompt>\n${exampleSystemPrompt || "No example system prompt provided."}\n</example_system_prompt>`,
    ].join("\n");
    const raw = await this.runModelPrompt(runtime, modelId, prompt, () => stubSystemPrompt(campaignName), signal);
    const extracted = extractWizardPlayerCharacter(raw);
    const stamped = stampCanonicalPcProtectionBlock(extracted.body, extracted.playerCharacterName);
    assertCampaignBodySurvived(stamped, "generation");
    const aligned = await this.alignSystemPrompt(runtime, modelId, stamped, extracted.playerCharacterName, signal);
    assertCampaignBodySurvived(aligned.draft, "alignment");
    return aligned;
  }

  private async generateLorebookCorpus(runtime: ChatRuntime | null, modelId: string, campaignName: string, wizardTranscript: string, signal?: AbortSignal): Promise<AlignedCorpus> {
    const prompt = [
      WIZARD_V3_CORPUS_PROMPT,
      "",
      `<campaign_name>\n${campaignName}\n</campaign_name>`,
      "",
      `<wizard_conversation>\n${wizardTranscript}\n</wizard_conversation>`,
    ].join("\n");
    const text = await this.runModelPrompt(runtime, modelId, prompt, () => "[]", signal);
    return this.alignCorpus(runtime, modelId, this.parseCorpusResponse(text), signal);
  }

  private parseCorpusResponse(text: string): LorebookCorpusEntry[] {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("no corpus array returned");
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) throw new Error("corpus must be an array");
      if (parsed.some((entry: unknown) => !entry || typeof entry !== "object" ||
        typeof (entry as { name?: unknown }).name !== "string" || !(entry as { name: string }).name.trim() ||
        typeof (entry as { content?: unknown }).content !== "string" || !(entry as { content: string }).content.trim())) {
        throw new Error("corpus contains an entry without a name or content");
      }
      return parsed
        .filter((e: any) => e && typeof e.name === "string" && typeof e.content === "string")
        .map((e: any) => ({
          name: String(e.name).trim(),
          tag: typeof e.tag === "string" ? e.tag.trim().toLowerCase() : null,
          content: String(e.content).trim(),
          // null/undefined members are dropped here, not stringified into "null" keys;
          // alignCorpus normalizes the rest (normalizeKeyList).
          keys: Array.isArray(e.keys) ? e.keys.filter((k: unknown) => k != null).map(String) : [e.name],
          keysSecondary: Array.isArray(e.keysSecondary) ? e.keysSecondary.filter((k: unknown) => k != null).map(String) : [],
          isConstant: Boolean(e.isConstant),
          // Retrieval fields are carried RAW here and validated through the
          // lorebook contract in alignCorpus so the review records
          // what the model asked for and what was substituted.
          position: typeof e.position === "string" ? e.position : undefined,
          insertionOrder: typeof e.insertionOrder === "number" ? e.insertionOrder : undefined,
          scanDepth: typeof e.scanDepth === "number" ? e.scanDepth : undefined,
          startingAttire: typeof e.startingAttire === "string" && e.startingAttire.trim() ? e.startingAttire.trim() : undefined,
          // Drive-seed strings normalize to the driveSheetSchema caps HERE, at
          // generation — the run's details are frozen once completed, and an
          // over-cap string would fail every approval attempt (2026-08-09: one
          // 310-char red line 500'd one campaign's approval until hand-patched).
          startingDrives: this.parseDriveSeed(e.startingDrives),
          startingSchemes: this.parseStartingSchemes(e.startingSchemes),
        }));
    } catch (error) {
      throw new Error(`lorebook corpus generation was invalid: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }

  /**
   * A generated drive seed, normalized to the drive sheet's caps HERE, at generation: the run's details are frozen once
   * completed, and an over-cap string would fail every approval attempt (2026-08-09: one 310-char red line 500'd one
   * campaign's approval until hand-patched). Red lines, leverage and concealment are carried at full strength regardless
   * of any dial: they are the structural capability a generated cast lost when this map once dropped them. An import
   * passes the cast's names, and a disposition toward anyone else is left off.
   */
  private parseDriveSeed(value: unknown, knownNames?: Map<string, string>): LorebookCorpusEntry["startingDrives"] {
    if (!value || typeof value !== "object") return undefined;
    const e = value as Record<string, any>;
    let dispositions: Record<string, string> | undefined = e.dispositions && typeof e.dispositions === "object" ? e.dispositions : undefined;
    if (dispositions && knownNames) {
      const kept = Object.entries(dispositions)
        .filter(([name, feeling]) => typeof feeling === "string" && feeling.trim() && knownNames.has(normalizeWizardCorpusName(name)))
        .slice(0, 6)
        .map(([name, feeling]) => [knownNames.get(normalizeWizardCorpusName(name))!, clampDriveSeedText(String(feeling), 400)] as const);
      dispositions = kept.length > 0 ? Object.fromEntries(kept) : undefined;
    }
    return {
      wants: Array.isArray(e.wants) ? e.wants.map(String).filter(Boolean).slice(0, 5).map((w: string) => clampDriveSeedText(w, 400)) : undefined,
      goals: Array.isArray(e.goals) ? e.goals.map(String).filter(Boolean).slice(0, 3).map((g: string) => clampDriveSeedText(g, 400)) : undefined,
      redLines: Array.isArray(e.redLines) ? normalizeDriveSeedList(e.redLines.map(String), 300, 6) : undefined,
      leverage: Array.isArray(e.leverage) ? normalizeDriveSeedList(e.leverage.map(String), 300, 6) : undefined,
      concealment: Array.isArray(e.concealment)
        ? e.concealment
            .filter((c: any) => c && typeof c.secret === "string" && typeof c.behavior === "string" && c.secret.trim() && c.behavior.trim())
            .map((c: any) => ({ secret: clampDriveSeedText(String(c.secret), 300), behavior: clampDriveSeedText(String(c.behavior), 400) }))
            .slice(0, 4)
        : undefined,
      offpageProject: typeof e.offpageProject === "string" && e.offpageProject.trim() ? clampDriveSeedText(e.offpageProject, 600) : undefined,
      dispositions,
    };
  }

  // ── SillyTavern lorebook import ────────────────────────────────────────────────────────────────────────────────────

  private async generateImportSystemPrompt(runtime: ChatRuntime | null, modelId: string, campaignName: string, source: StoredWizardImportSource, playerCharacterName: string, exampleSystemPrompt: string, contextTokens: number, signal?: AbortSignal): Promise<AlignedSystemPrompt> {
    const enabled = source.entries.filter((entry) => entry.activation.enabled);
    const prompt = [
      WIZARD_V3_SYSTEM_PROMPT,
      "",
      importSystemPromptNote(playerCharacterName),
      "",
      `<campaign_name>\n${campaignName}\n</campaign_name>`,
      "",
      `<owner_notes>\n${source.notes || "No notes."}\n</owner_notes>`,
      "",
      `<imported_lorebook>\n${formatLorebookForPrompt(enabled, lorebookBudgetChars(contextTokens))}\n</imported_lorebook>`,
      "",
      `<example_system_prompt>\n${exampleSystemPrompt || "No example system prompt provided."}\n</example_system_prompt>`,
    ].join("\n");
    const raw = await this.runModelPrompt(runtime, modelId, prompt, () => stubSystemPrompt(campaignName, playerCharacterName), signal);
    // The owner named the player character at import, so the model's marker line cannot change it.
    const stamped = stampCanonicalPcProtectionBlock(extractWizardPlayerCharacter(raw).body, playerCharacterName);
    assertCampaignBodySurvived(stamped, "generation");
    const aligned = await this.alignSystemPrompt(runtime, modelId, stamped, playerCharacterName, signal);
    assertCampaignBodySurvived(aligned.draft, "alignment");
    return aligned;
  }

  /** One model call whose answer must parse; a garbled answer is asked for once more. */
  private async promptForJson<T>(runtime: ChatRuntime | null, modelId: string, prompt: string, parse: (text: string) => T, isEmpty: (value: T) => boolean, signal?: AbortSignal): Promise<T> {
    const first = parse(await this.runModelPrompt(runtime, modelId, prompt, () => "[]", signal));
    if (!isEmpty(first) || !runtime) return first;
    return parse(await this.runModelPrompt(runtime, modelId, `${prompt}\n\nYour last answer could not be read as the JSON array asked for. Return only the JSON array.`, () => "[]", signal));
  }

  private async convertImportedLorebook(runtime: ChatRuntime | null, modelId: string, source: StoredWizardImportSource, playerCharacterName: string, contextTokens: number, maxOutputTokens: number, progress: (text: string) => void, signal?: AbortSignal): Promise<AlignedCorpus & { unsorted: number }> {
    const pc = playerCharacterName;
    const entries = source.entries;

    // Pass 1: sort every entry. The index lets the model see a character's entries in other batches.
    const indexText = formatEntryIndex(entries, Math.min(lorebookBudgetChars(contextTokens, 0.15), 120_000));
    const sortBatches = batchBySize(entries, (entry) => Math.min(entry.content.length, 4000) + entry.title.length + 80, 60_000, 40);
    const sorts = new Map<number, ImportSort>();
    let sorted = 0;
    progress(`Sorting entries: batch 0 of ${sortBatches.length}`);
    await runLimited(sortBatches, 3, async (batch) => {
      const prompt = [
        importSortPrompt(pc),
        "",
        `<entry_index>\n${indexText}\n</entry_index>`,
        "",
        `<entries_to_sort>\n${formatLorebookForPrompt(batch, Infinity, 4000)}\n</entries_to_sort>`,
      ].join("\n");
      const result = await this.promptForJson(runtime, modelId, prompt, (text) => parseSortResponse(text, batch), (map) => map.size === 0, signal);
      for (const [index, sort] of result) sorts.set(index, sort);
      sorted += 1;
      progress(`Sorting entries: batch ${sorted} of ${sortBatches.length}`);
    });
    const plan = planImportedCorpus(entries, sorts, pc);
    const corpus = plan.entries.map((planned) => importedCorpusEntry(planned, source.charName));

    // Pass 2: prepare every character whose entry is on, the way the wizard prepares its own cast.
    const slots = plan.entries.map((planned, position) => ({ planned, position })).filter(({ planned }) => planned.character && planned.source.activation.enabled);
    if (slots.length > 0) {
      const castNames = new Map(slots.map(({ planned }) => [normalizeWizardCorpusName(planned.name), planned.name] as const));
      const entryNames = corpus.map((entry) => entry.name).join("\n");
      const world = formatLorebookForPrompt(entries.filter((entry) => entry.isConstant && entry.activation.enabled), Math.min(lorebookBudgetChars(contextTokens, 0.1), 60_000));
      const satellites = (name: string) => plan.entries.filter((planned) => planned.name.startsWith(`${name} — `)).map((planned) => planned.source);
      const perBatch = Math.max(1, Math.min(6, Math.floor(maxOutputTokens / 2500)));
      const batches = batchBySize(slots, ({ planned }) => planned.source.content.length + satellites(planned.name).reduce((sum, entry) => sum + entry.content.length, 0), 80_000, perBatch);
      let prepared = 0;
      progress(`Preparing characters: 0 of ${slots.length}`);
      await runLimited(batches, 3, async (batch) => {
        const characters = batch.map(({ planned }) => {
          const marks = `${planned.playerCharacter ? " player_character=\"true\"" : ""}${planned.antagonist ? " antagonist=\"true\"" : ""}`;
          return `<character name="${planned.name}"${marks}>\n${formatLorebookForPrompt([planned.source, ...satellites(planned.name)], 40_000)}\n</character>`;
        }).join("\n\n");
        const prompt = [
          importCharacterPrompt(pc, source.addCharacterSections),
          "",
          `<world>\n${world || "No always-on entries."}\n</world>`,
          "",
          `<character_names>\n${[...castNames.values()].join("\n")}\n</character_names>`,
          "",
          `<entry_names>\n${entryNames}\n</entry_names>`,
          "",
          `<characters>\n${characters}\n</characters>`,
        ].join("\n");
        const result = await this.promptForJson(runtime, modelId, prompt, (text) => parseCharacterResponse(text, batch.map(({ planned }) => planned.name)), (map) => map.size === 0, signal);
        for (const { planned, position } of batch) {
          const preparation = result.get(normalizeWizardCorpusName(planned.name));
          if (!preparation) continue;
          let entry = corpus[position]!;
          if (preparation.startingAttire) entry = { ...entry, startingAttire: preparation.startingAttire };
          if (!planned.playerCharacter) {
            const drives = this.parseDriveSeed(preparation.startingDrives, castNames);
            if (drives) entry = { ...entry, startingDrives: drives };
            const schemes = planned.antagonist ? this.parseStartingSchemes(preparation.startingSchemes) : undefined;
            if (schemes) entry = { ...entry, startingSchemes: schemes };
          }
          if (source.addCharacterSections) {
            const appended = appendCharacterSections(entry.content, preparation.sections, pc, planned.playerCharacter);
            if (appended.added.length > 0) entry = { ...entry, content: appended.content, origin: { kind: "imported", source: planned.source.title, added: appended.added } };
          }
          corpus[position] = entry;
        }
        prepared += batch.length;
        progress(`Preparing characters: ${prepared} of ${slots.length}`);
      });
    }

    // Pass 3: the rule entries a campaign built here starts with, unless the lorebook already does their job.
    progress("Writing rule entries");
    const rulesPrompt = [
      importRulesPrompt(pc),
      "",
      `<owner_notes>\n${source.notes || "No notes."}\n</owner_notes>`,
      "",
      `<imported_lorebook>\n${formatLorebookForPrompt(entries.filter((entry) => entry.activation.enabled), lorebookBudgetChars(contextTokens, 0.35))}\n</imported_lorebook>`,
    ].join("\n");
    const rules = await this.promptForJson(runtime, modelId, rulesPrompt, parseRulesResponse, (value) => value.rules.length === 0 && value.covered.length === 0, signal);
    const used = new Set(corpus.map((entry) => normalizeWizardCorpusName(entry.name)));
    for (const rule of rules.rules) {
      let name = rule.name;
      for (let n = 2; used.has(normalizeWizardCorpusName(name)); n += 1) name = `${rule.name} (${n})`;
      used.add(normalizeWizardCorpusName(name));
      corpus.push({ name, tag: "rules", content: rule.content, keys: rule.keys, isConstant: rule.isConstant, origin: { kind: "generated" } });
    }

    progress("Checking entries");
    const aligned = await this.alignCorpus(runtime, modelId, corpus, signal, { keepUnrepaired: (entry) => entry.origin?.kind === "imported" });
    for (const covered of rules.covered) {
      aligned.autoCorrections.push({
        code: "import_rule_covered",
        scope: "corpus",
        location: covered.name,
        summary: `The lorebook's "${covered.covers}" already does this job, so no ${covered.name} entry was added.`,
        before: covered.name,
        after: covered.covers,
        verified: true,
      });
    }
    return { ...aligned, unsorted: plan.unsorted };
  }

  private parseStartingSchemes(value: unknown): AntagonistScheme[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const schemes = value.map((item) => antagonistSchemeSchema.safeParse(item))
      .filter((result): result is { success: true; data: AntagonistScheme } => result.success)
      .map((result) => result.data)
      .slice(0, 1);
    return schemes.length > 0 ? schemes : undefined;
  }

  private async alignSystemPrompt(runtime: ChatRuntime | null, modelId: string, draft: string, playerCharacterName: string, signal?: AbortSignal): Promise<AlignedSystemPrompt> {
    const findings = lintWizardSystemPrompt(draft, playerCharacterName);
    if (findings.length === 0) return { draft, playerCharacterName, autoCorrections: [], lintResidue: [] };

    try {
      const response = await this.runModelPrompt(runtime, modelId, [
        "You correct machine-generated campaign firmware. Return JSON only: {\"correctedPrompt\":\"full corrected prompt\"}.",
        "Preserve campaign-specific tone, style, stakes, and information boundaries. Remove every listed contradiction. Do not write Section A; it is server-owned and will be stamped after your response.",
        "Do not add floor-yielding absolutes, world-passivity rules, permission loops, or reply-ending mandates.",
        "",
        `<findings>\n${JSON.stringify(findings)}\n</findings>`,
        "",
        `<generated_prompt_without_section_a>\n${stripWizardPcProtectionSections(draft)}\n</generated_prompt_without_section_a>`,
      ].join("\n"), () => '{"correctedPrompt":""}', signal);
      const parsed = parseFirstJson<{ correctedPrompt?: unknown }>(response, "{");
      if (typeof parsed?.correctedPrompt === "string" && parsed.correctedPrompt.trim()) {
        const candidate = stampCanonicalPcProtectionBlock(parsed.correctedPrompt, playerCharacterName);
        if (lintWizardSystemPrompt(candidate, playerCharacterName).length === 0) {
          const verified = await this.verifyWizardCorrection(runtime, modelId, "system prompt", draft, candidate, findings, signal);
          if (verified) {
            return {
              draft: candidate,
              playerCharacterName,
              autoCorrections: findings.map((finding) => this.toAutoCorrection(
                finding,
                "Rewrote the conflicting generated section while preserving campaign intent.",
                true,
                this.sectionExcerpt(candidate, finding.location),
              )),
              lintResidue: [],
            };
          }
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "wizard system-prompt auto-correction reviewer failed");
    }

    // Fail closed: if the model repair or reviewer is unavailable, remove the
    // specific generated lines that carry interaction mechanics. The canonical
    // block remains byte-for-byte intact and the deterministic lint runs again.
    const fallback = this.removeFlaggedSystemLines(draft, findings, playerCharacterName);
    const residue = lintWizardSystemPrompt(fallback, playerCharacterName);
    return {
      draft: fallback,
      playerCharacterName,
      autoCorrections: findings.map((finding) => this.toAutoCorrection(finding, residue.length === 0 ? "Removed an isolated conflicting instruction under the deterministic firmware guard." : "Preserved ambiguous compound instructions for review; automatic repair could not safely separate campaign intent.", residue.length === 0, this.sectionExcerpt(fallback, finding.location))),
      lintResidue: residue,
    };
  }

  private async alignCorpus(runtime: ChatRuntime | null, modelId: string, entries: LorebookCorpusEntry[], signal?: AbortSignal, options: AlignOptions = {}): Promise<AlignedCorpus> {
    const autoCorrections: WizardAutoCorrection[] = [];
    const lintResidue: WizardLintFinding[] = [];
    // Reserved lifecycle tags fall back to `events` through the one tag
    // sanitizer every machine CREATE path shares.
    // A `threads` entry used to be excluded outright, which dropped generated
    // campaign content; `archived` passed through and made an ordinary entry
    // look like a compressed archive trigger.
    const guarded = entries.map((entry) => {
      const sanitized = sanitizeCreateTag(entry.tag);
      if (sanitized.retagged) {
        autoCorrections.push({
          code: "reserved_tag",
          scope: "corpus",
          location: entry.name,
          summary: "Changed a reserved tag to events: threads belongs to the thread tracker and archived marks compressed archive entries.",
          before: `tag: ${entry.tag}`,
          after: `tag: ${sanitized.tag}`,
          verified: true,
        });
      }
      return sanitized.tag === entry.tag ? entry : { ...entry, tag: sanitized.tag };
    });
    // One entry per name. Approval keys attire and drive
    // seeds by name and inserts every entry, so a repeated name used to create
    // two lorebook rows (both retrieve, both bill the budget) while the LATER
    // duplicate's seeds silently overwrote the first's. Keep the first — the
    // model's primary treatment — and say so.
    const seenNames = new Set<string>();
    const deduped = guarded.filter((entry) => {
      const key = normalizeWizardCorpusName(entry.name);
      if (!seenNames.has(key)) { seenNames.add(key); return true; }
      autoCorrections.push({
        code: "duplicate_entry_name",
        scope: "corpus",
        location: entry.name,
        summary: "Removed a repeated entry name: approval creates one lorebook row per entry and keys attire/drive seeds by name, so the later duplicate would have doubled retrieval and silently overwritten the first entry's seeds.",
        before: `${entry.name} [${entry.tag ?? "untagged"}] (second occurrence)`,
        after: "(entry excluded — the first entry with this name is kept)",
        verified: true,
      });
      return false;
    });
    // Valid scheme targets = ANY established entry EXCEPT the scheme's own
    // bearer. Character entries were wrongly excluded from this set until
    // 2026-08-09, which silently discarded canon-perfect schemes aimed at
    // people (one wizard run lost two canon schemes against named characters to
    // it) — an antagonist's victim is usually a character. Hallucinated
    // citations still drop: the name must match a generated entry exactly.
    const corpusNames = new Set(deduped.map((entry) => normalizeWizardCorpusName(entry.name)));
    const aligned: LorebookCorpusEntry[] = [];

    for (const sourceEntry of deduped) {
      let entry = sourceEntry;
      // Retrieval fields through the lorebook HTTP contract: an
      // out-of-enum position or an unbounded scanDepth used to reach the row.
      const retrieval = normalizeCorpusRetrievalFields(entry);
      if (retrieval.corrections.length > 0) {
        autoCorrections.push({
          code: "corpus_retrieval_fields",
          scope: "corpus",
          location: entry.name,
          summary: "Replaced retrieval fields the lorebook contract refuses with its defaults.",
          before: retrieval.corrections.join("; "),
          after: `position ${retrieval.position}, scanDepth ${retrieval.scanDepth}, insertionOrder ${retrieval.insertionOrder}`,
          verified: true,
        });
      }
      entry = { ...entry, position: retrieval.position, scanDepth: retrieval.scanDepth, insertionOrder: retrieval.insertionOrder };
      // The one key rule of every lorebook write:
      // trimmed, no blank key (a blank key matches almost any text), no
      // case-insensitive repeat, at most LOREBOOK_MAX_KEYS so the editor can
      // save the entry. A list left empty falls back to the entry name, as a
      // missing `keys` does in parseCorpusResponse.
      const primaryList = normalizeKeyList(entry.keys);
      const secondaryList = normalizeKeyList(entry.keysSecondary ?? []);
      const leftOff = [...primaryList.overCap, ...primaryList.overLong, ...secondaryList.overCap, ...secondaryList.overLong];
      if (leftOff.length > 0 || primaryList.keys.length === 0) {
        autoCorrections.push({
          code: "key_list_limits",
          scope: "corpus",
          location: entry.name,
          summary: primaryList.keys.length === 0
            ? "The entry had no usable keys, so its name is now its only keyword."
            : "Left off keys past the lorebook's limits (100 keys per list, 500 characters per key).",
          before: leftOff.length > 0 ? leftOff.join(", ").slice(0, 500) : "(no usable keys)",
          after: primaryList.keys.length > 0 ? `${primaryList.keys.length} keys kept` : entry.name,
          verified: true,
        });
      }
      entry = {
        ...entry,
        keys: primaryList.keys.length > 0 ? primaryList.keys : [entry.name],
        ...(entry.keysSecondary !== undefined ? { keysSecondary: secondaryList.keys } : {}),
      };
      // Deterministic key hygiene: bare function/calendar keys fire every turn
      // and make the entry an accidental constant (2026-07-13 date-board class).
      const primaryKeys = splitBroadRetrievalKeys(entry.keys);
      const secondaryKeys = splitBroadRetrievalKeys(entry.keysSecondary);
      if (primaryKeys.dropped.length > 0 || secondaryKeys.dropped.length > 0) {
        // Keyword activation matches keys, never an entry's name, so an entry
        // left with no primary key is reachable only through semantic
        // retrieval (or the researcher). Fall back to the name as its one key
        // — what parseCorpusResponse does when `keys` is absent — and tell
        // the reviewer the truth.
        const kept = primaryKeys.kept.length > 0 ? primaryKeys.kept : [entry.name];
        autoCorrections.push({
          code: "broad_retrieval_keys",
          scope: "corpus",
          location: entry.name,
          summary: "Dropped always-fire retrieval keys (bare function/calendar words) so the entry activates on real references, not every turn.",
          before: [...primaryKeys.dropped, ...secondaryKeys.dropped].join(", "),
          after: primaryKeys.kept.length > 0 ? primaryKeys.kept.join(", ") : `${entry.name} (no distinctive keys were left — the entry name is now its only keyword; add keys in the Lorebook panel after approval, semantic retrieval still applies)`,
          verified: true,
        });
        entry = { ...entry, keys: kept, keysSecondary: secondaryKeys.kept.length > 0 ? secondaryKeys.kept : undefined };
      }
      if (entry.startingSchemes?.length) {
        const selfName = normalizeWizardCorpusName(entry.name);
        const validSchemes = entry.startingSchemes.filter((scheme) => {
          const target = normalizeWizardCorpusName(scheme.targetCitation);
          return target !== selfName && corpusNames.has(target);
        });
        if (validSchemes.length !== entry.startingSchemes.length) {
          autoCorrections.push({
            code: "unsupported_scheme_citation",
            scope: "corpus",
            location: entry.name,
            summary: "Removed a generated antagonist scheme whose target citation did not name an established corpus entry.",
            before: entry.startingSchemes.map((scheme) => scheme.targetCitation).join(", "),
            after: validSchemes.length > 0 ? validSchemes.map((scheme) => scheme.targetCitation).join(", ") : "(scheme omitted)",
            verified: true,
          });
          entry = { ...entry, startingSchemes: validSchemes.length > 0 ? validSchemes : undefined };
        }
      }

      const findings = lintWizardCorpusEntry(entry).filter((finding) => finding.code !== "reserved_threads_tag");
      if (findings.length === 0) {
        aligned.push(entry);
        continue;
      }
      const repaired = await this.repairCorpusEntry(runtime, modelId, entry, findings, null, signal, options.keepUnrepaired?.(entry) ?? false);
      if (repaired.entry) aligned.push(repaired.entry);
      autoCorrections.push(...repaired.autoCorrections);
    }

    const revalidated = this.revalidateSchemeCitations(aligned, autoCorrections, "Removed a generated antagonist scheme whose target entry was excluded from the corpus during alignment.");
    for (const entry of revalidated) lintResidue.push(...lintWizardCorpusEntry(entry));
    return { entries: revalidated, autoCorrections, lintResidue };
  }

  /**
   * The corpus and the system prompt generate in parallel, so alignCorpus
   * runs while the player character's name is still unknown and the NAMED
   * duplicate_pc_authority pattern ("The narrator must never write dialogue
   * for Corin") never had a
   * name to match. Every generated corpus completed with an empty residue
   * and seeded such an entry as a constant: a second authority contract
   * outside Section A on every turn. Once the prompt
   * side has resolved the name, re-lint the final corpus with it and repair
   * or exclude exactly as the alignment loop does.
   */
  private async alignCorpusForPlayerCharacter(runtime: ChatRuntime | null, modelId: string, entries: LorebookCorpusEntry[], playerCharacterName: string, signal?: AbortSignal, options: AlignOptions = {}): Promise<AlignedCorpus> {
    const autoCorrections: WizardAutoCorrection[] = [];
    const lintResidue: WizardLintFinding[] = [];
    const aligned: LorebookCorpusEntry[] = [];
    let changed = false;
    for (const entry of entries) {
      const findings = lintWizardCorpusEntry(entry, playerCharacterName).filter((finding) => finding.code !== "reserved_threads_tag");
      if (findings.length === 0) {
        aligned.push(entry);
        continue;
      }
      changed = true;
      const repaired = await this.repairCorpusEntry(runtime, modelId, entry, findings, playerCharacterName, signal, options.keepUnrepaired?.(entry) ?? false);
      if (repaired.entry) aligned.push(repaired.entry);
      autoCorrections.push(...repaired.autoCorrections);
    }
    if (!changed) return { entries, autoCorrections, lintResidue };
    const revalidated = this.revalidateSchemeCitations(aligned, autoCorrections, "Removed a generated antagonist scheme whose target entry was excluded from the corpus by the named player-character lint.");
    for (const entry of revalidated) lintResidue.push(...lintWizardCorpusEntry(entry, playerCharacterName));
    return { entries: revalidated, autoCorrections, lintResidue };
  }

  /**
   * Model repair + adversarial verification of ONE flagged corpus entry.
   * `entry: null` means the entry is excluded: an unverified machine-authored
   * entry is safer to omit than to seed as durable lorebook firmware, and the
   * auto-corrections explain the exclusion instead of presenting a punch list.
   */
  private async repairCorpusEntry(runtime: ChatRuntime | null, modelId: string, entry: LorebookCorpusEntry, findings: WizardLintFinding[], playerCharacterName: string | null, signal?: AbortSignal, keepUnrepaired = false): Promise<{ entry: LorebookCorpusEntry | null; autoCorrections: WizardAutoCorrection[] }> {
    // Imported text belongs to the owner, so its repair is surgical. A flagged line that is one sentence is the
    // instruction itself: it is dropped without a model call. A real book's line "Never write the player's internal
    // monologue or actions." went to the model, which also cut the book's own "End every turn with exactly 4 options.",
    // and the reviewer rightly refused the edit (SillyTavern import, 2026-10-02).
    if (keepUnrepaired) {
      const stripped = removeIsolatedFlaggedLines(entry.content, findings, (content) => lintWizardCorpusEntry({ ...entry, content }, playerCharacterName));
      if (stripped !== null && stripped.trim()) {
        return {
          entry: { ...entry, content: stripped },
          autoCorrections: findings.map((finding) => this.toAutoCorrection(finding, "Removed the player-authority line from the imported entry; everything else is as written.", true, "(line removed)")),
        };
      }
    }
    let corrected: LorebookCorpusEntry | null = null;
    try {
      const response = await this.runModelPrompt(runtime, modelId, [
        keepUnrepaired
          ? "Correct one lorebook entry imported from another app. Return JSON only: {\"content\":\"corrected content\"}."
          : "Correct one machine-generated lorebook entry. Return JSON only: {\"content\":\"corrected content\"}.",
        keepUnrepaired
          ? "Remove only the instruction quoted in each finding's excerpt. Every other line stays exactly as written, including its formatting and any other rules the entry gives. Where a quoted line also says something else, keep that part and drop only the instruction. Do not add anything."
          : "Preserve every canon and characterization fact. Remove only player/world turn-taking mechanics, world-passivity rules, permission loops, and reply-ending mandates. Do not add new facts.",
        "",
        `<findings>\n${JSON.stringify(findings)}\n</findings>`,
        `<entry_name>${entry.name}</entry_name>`,
        `<entry_content>\n${entry.content}\n</entry_content>`,
      ].join("\n"), () => '{"content":""}', signal);
      const parsed = parseFirstJson<{ content?: unknown }>(response, "{");
      if (typeof parsed?.content === "string" && parsed.content.trim()) {
        const candidate = { ...entry, content: parsed.content.trim() };
        if (lintWizardCorpusEntry(candidate, playerCharacterName).length === 0) {
          const verified = await this.verifyWizardCorrection(runtime, modelId, `lorebook entry ${entry.name}`, entry.content, candidate.content, findings, signal);
          if (verified) corrected = candidate;
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.logger.warn({ entry: entry.name, error: error instanceof Error ? error.message : String(error) }, "wizard corpus auto-correction reviewer failed");
    }
    if (corrected) {
      const repairedContent = corrected.content;
      return { entry: corrected, autoCorrections: findings.map((finding) => this.toAutoCorrection(finding, keepUnrepaired ? "Removed the player-authority lines from the imported entry and kept its canon facts." : "Rewrote the generated entry while preserving its canon facts.", true, repairedContent.slice(0, 240))) };
    }
    // Imported text belongs to the owner: kept as written, and the finding stays in the review's advisories.
    if (keepUnrepaired) return { entry, autoCorrections: [] };
    return { entry: null, autoCorrections: findings.map((finding) => this.toAutoCorrection(finding, "Excluded the generated entry after its correction could not be verified.", true, "(entry excluded)")) };
  }

  /**
   * Re-validate scheme citations against the FINAL corpus: the
   * citation set is computed before an alignment pass, and an entry excluded
   * later (unverifiable correction) could still be cited — approval would then
   * seed a sealed scheme with a dangling target.
   */
  private revalidateSchemeCitations(entries: LorebookCorpusEntry[], autoCorrections: WizardAutoCorrection[], summary: string): LorebookCorpusEntry[] {
    const finalNames = new Set(entries.map((entry) => normalizeWizardCorpusName(entry.name)));
    return entries.map((entry) => {
      if (!entry.startingSchemes?.length) return entry;
      const valid = entry.startingSchemes.filter((scheme) => finalNames.has(normalizeWizardCorpusName(scheme.targetCitation)));
      if (valid.length === entry.startingSchemes.length) return entry;
      autoCorrections.push({
        code: "unsupported_scheme_citation",
        scope: "corpus",
        location: entry.name,
        summary,
        before: entry.startingSchemes.map((scheme) => scheme.targetCitation).join(", "),
        after: valid.length > 0 ? valid.map((scheme) => scheme.targetCitation).join(", ") : "(scheme omitted)",
        verified: true,
      });
      return { ...entry, startingSchemes: valid.length > 0 ? valid : undefined };
    });
  }

  private async verifyWizardCorrection(runtime: ChatRuntime | null, modelId: string, subject: string, before: string, after: string, findings: WizardLintFinding[], signal?: AbortSignal): Promise<boolean> {
    if (!runtime) return false;
    const response = await this.runModelPrompt(runtime, modelId, [
      "You are an adversarial reviewer of a machine-generated wizard correction. Return JSON only: {\"ok\":true|false,\"reason\":\"short reason\"}.",
      "Approve only if every listed contradiction is gone, the original campaign-specific intent and facts are preserved, no replacement contradiction was introduced, and no player/world interaction mechanics were moved elsewhere.",
      `Subject: ${subject}`,
      `<findings>\n${JSON.stringify(findings)}\n</findings>`,
      `<before>\n${before}\n</before>`,
      `<after>\n${after}\n</after>`,
    ].join("\n"), () => '{"ok":false,"reason":"review unavailable"}', signal);
    const parsed = parseFirstJson<{ ok?: unknown }>(response, "{");
    return parsed?.ok === true;
  }

  private removeFlaggedSystemLines(draft: string, findings: WizardLintFinding[], playerCharacterName: string): string {
    const lines = stripWizardPcProtectionSections(draft).split("\n");
    const rejected = new Set(findings.map((finding) => finding.line).filter((line): line is number => line != null));
    // A lint hit can share a line with unrelated owner intent. Only an isolated
    // instruction is safe to drop; ambiguous clauses remain as visible residue.
    const body = lines.filter((line, index) => !rejected.has(index + 1) || /[;:]|[.!?]\s+\S|\b(?:and|but|or|while)\b/i.test(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return stampCanonicalPcProtectionBlock(body, playerCharacterName);
  }

  private sectionExcerpt(prompt: string, location: string): string {
    const lines = stripWizardPcProtectionSections(prompt).split("\n");
    const headingIndex = lines.findIndex((line) => line.trim().replace(/^##\s+/, "") === location);
    if (headingIndex < 0) return prompt.trim().slice(0, 240);
    const section: string[] = [];
    for (let index = headingIndex + 1; index < lines.length && !/^##\s+/.test(lines[index]!.trim()); index += 1) {
      if (lines[index]!.trim()) section.push(lines[index]!.trim());
    }
    return section.join(" ").slice(0, 240) || "(section retained without the conflicting line)";
  }

  private toAutoCorrection(finding: WizardLintFinding, summary: string, verified: boolean, after: string): WizardAutoCorrection {
    return { code: finding.code, scope: finding.scope, location: finding.location, summary, before: finding.excerpt, after, verified };
  }

  private async runModelPrompt(runtime: ChatRuntime | null, modelId: string, prompt: string, fallback: () => string, signal?: AbortSignal) {
    if (!runtime) {
      // The stub output is ONLY for the explicit mock runtime (MOCK_PROVIDER).
      // A user with no provider key also arrives here with a null runtime, and
      // used to get a "completed" run whose approval created a campaign from a
      // 7-line stub prompt and an empty corpus — the very outcome the API-error
      // branch below was fixed to prevent. Every pipeline kind fails
      // loudly on a null runtime; the wizard does the same.
      if (this.mockRuntime) return fallback();
      throw new Error(`no chat runtime available for ${modelId} — add a provider key for its provider and retry the wizard`);
    }
    let text = "";
    let completed = false;
    try {
      // Wizard calls run with NO deadline and NO provider total-stream ceiling
      // (streamTimeoutMs: 0) since 2026-08-09, after a 30-min
      // deadline killed a corpus generation. A corpus on a big canon cast
      // may legitimately outrun any fixed timer; the run's Cancel button
      // (watchForCancellation → abort) is the escape hatch, and a bytes-dead
      // stream still trips provider-runtime's SSE inactivity gate.
      await withRetry(() => runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt }],
        requestId: randomUUID(),
        thinkingMode: "adaptive",
        effort: "max",
        signal,
        streamTimeoutMs: 0,
      }, {
        onStart: () => { text = ""; },
        onDelta: (delta) => { text += delta; },
        onThinkingDelta: () => {},
        onComplete: () => { completed = true; },
      }), undefined, signal);
    } catch (error) {
      // Only a real run-cancel may propagate as an abort — the outer catch maps
      // AbortError → "canceled". With the wizard deadline gone, any transport
      // abort arriving while the run is NOT canceled must surface as a failure,
      // never a phantom cancel.
      if (error instanceof Error && error.name === "AbortError") {
        if (signal?.aborted) throw error;
        throw new Error(`wizard model call failed (${modelId}): transport aborted the stream (${error.message})`);
      }
      // THROW instead of silently substituting the fallback: a transient API
      // error used to produce a "completed" run whose approval created a
      // campaign with a 2-line stub system prompt and an empty lorebook. The
      // outer run loop marks the run failed (which records a system event),
      // and the user retries instead of approving junk.
      throw new Error(`wizard model call failed (${modelId}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!completed || !text.trim()) {
      throw new Error(`wizard model returned ${completed ? "empty output" : "no completion"} (${modelId})`);
    }
    return text.trim();
  }
}

/**
 * Drops each flagged line that is a single sentence (a list marker aside), re-linting after each pass, and returns
 * the text once the lint is clean. Null when a flagged line carries more than one sentence or the lint does not clear:
 * the model then repairs it, under the reviewer.
 */
export function removeIsolatedFlaggedLines(content: string, findings: WizardLintFinding[], relint: (content: string) => WizardLintFinding[]): string | null {
  let text = content;
  let pending = findings;
  for (let pass = 0; pass < 10 && pending.length > 0; pass += 1) {
    const lines = text.split("\n");
    const drop = new Set<number>();
    for (const finding of pending) {
      if (finding.line == null) return null;
      const line = lines[finding.line - 1];
      if (line === undefined) return null;
      const sentence = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      if (!sentence || /[.!?]["'”’)]*\s+\S/.test(sentence) || sentence.includes(";")) return null;
      drop.add(finding.line - 1);
    }
    text = lines.filter((_, index) => !drop.has(index)).join("\n").replace(/\n{3,}/g, "\n\n");
    pending = relint(text);
  }
  return pending.length === 0 ? text : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
