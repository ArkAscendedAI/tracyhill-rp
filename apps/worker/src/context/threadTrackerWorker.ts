import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../../../api/src/domain/context/embeddingService";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";

// The Thread Index is a single CONSTANT lorebook entry — always in context. It carries
// one descriptive line per active thread (no detail). preventRecursion stops its content
// from cascading activations. Identified by this exact name + tag.
const INDEX_ENTRY_NAME = "Campaign Thread Tracker";
const THREAD_TAG = "threads";
const MAX_ACTIVE_THREADS = 80;
// Fall-off: a resolved/abandoned thread stays in the tracker for this many of the
// most-recently-resolved slots (short-term continuity). Older resolved threads GRADUATE —
// they leave the tracker and their entry re-tags threads -> events. This keeps the index
// comment, the per-cycle re-emission, and the threads-tag entry count bounded.
const GRACE_RESOLVED = 10;
const RECENT_TURN_WINDOW = 12; // assistant+user messages read for change detection
// Threads activate via keyword/semantic/researcher — no sticky carry-over (was THREAD_STICKY, fixed at 0 since 2026-05-26).
const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-large";

const THREAD_TRACKER_SYSTEM = `You maintain the THREAD TRACKER for an ongoing roleplay campaign — the canonical, dynamic record of every pending narrative thread (quests, operations, mysteries, promises, unresolved tensions, plans-in-motion).

You will receive the CURRENT tracker state (all existing threads) and the most recent story turns. You must output the COMPLETE updated thread list as JSON — every thread, every run. This is full re-emission, not a diff.

WHAT IS A THREAD: a pending narrative obligation the story must eventually pay off. Examples: "rescue the captured villager", "the SOC must be staffed", "Serena's long-term fate must be decided", "James promised to teach Willow the attunement". NOT a thread: a concluded scene, a static fact, a character trait — those belong in the regular lorebook.

For EACH thread output an object:
{
  "id": "T03",                       // stable — NEVER renumber an existing thread; reuse its id
  "title": "Serena's disposition",   // short, distinctive, stable
  "headline": "Fallen primordial held in S6; James deciding her long-term fate",  // <= 18 words, descriptive — this is the one-line index entry
  "status": "ACTIVE",                // OPEN (just introduced) | ACTIVE (being worked) | STALLED (blocked/waiting) | RESOLVED (concluded) | ABANDONED (dropped, will not pay off)
  "openedDate": "Sept 30, 1998",     // in-world date the thread began
  "openedTurn": 2180,
  "involved": ["James", "Buffy", "Willow", "Serena"],
  "summary": "1-3 sentences: what the thread IS and where it currently stands.",
  "nextBeat": "1 sentence: the concrete next thing that must happen.",
  "pendingDates": "Willow translation due ~Oct 5",  // deadlines / scheduled beats / due dates, or "" if none
  "log": ["Sept 30 — opened: Serena captured, placed in S6", "Oct 2 — four-person cell visit"],  // append-only dated chronology
  "lastUpdatedDate": "Oct 2, 1998",
  "lastUpdatedTurn": 2204
}

HARD RULES — these are enforced; violating them rejects your output:

1. FULL RE-EMISSION. Output EVERY thread from the current state, plus any new ones. Never omit a thread. If a thread is no longer pending, you must explicitly set its status to RESOLVED or ABANDONED — never drop it silently.

2. CARRY-FORWARD. Every thread id in the current state MUST appear in your output. A missing id is a failure.

3. STABLE IDS. Reuse each thread's existing id. New threads get the next free id (T<N>). Never renumber.

4. DATED CHRONOLOGY. Every status change or material development appends a log line dated with the in-world date it happened (read the recent turns' scene metadata for dates). If multiple developments happened since the last run, log each. The opened-date log line is never removed.

5. REQUIRED DETAIL. Every non-resolved thread MUST have a non-empty headline, summary, and nextBeat. headline must be descriptive enough to inform on its own.

6. UPDATE PRESSURE. For each ACTIVE thread, check the recent turns: if it progressed, update summary/nextBeat and append a log line. If it has clearly stalled, set STALLED. If it concluded, set RESOLVED with a final log line. Do not leave a thread untouched if the recent turns moved it.

7. OPEN NEW THREADS. If the recent turns introduce a new pending obligation, open a thread for it (status OPEN).

8. CONSOLIDATE, never lossy-compress. If two threads are genuinely facets of one arc, merge them into one (keep the lower id, fold the other's log in, note the merge). Do NOT summarize away detail from a single thread — detail is preserved in full.

9. CAP: at most ${MAX_ACTIVE_THREADS} non-resolved threads. If you would exceed it, you must RESOLVE, ABANDON, or consolidate first.

10. log: keep the opened line + the most recent ~8 lines per thread; if older lines must go, fold their substance into the summary first.

Output ONLY a JSON object: {"threads": [ ...all threads... ]}. No prose, no markdown fences.`;

interface ThreadRecord {
  id: string;
  title: string;
  headline: string;
  status: string;
  openedDate: string;
  openedTurn: number;
  involved: string[];
  summary: string;
  nextBeat: string;
  pendingDates: string;
  log: string[];
  lastUpdatedDate: string;
  lastUpdatedTurn: number;
  entryId?: string; // the per-thread lorebook entry id (assigned by this worker, not the LLM)
}

const VALID_STATUS = new Set(["OPEN", "ACTIVE", "STALLED", "RESOLVED", "ABANDONED"]);
const PENDING_STATUS = new Set(["OPEN", "ACTIVE", "STALLED"]);

export class ThreadTrackerWorker {
  private readonly logger = createLogger("thread-tracker-worker");
  private readonly lorebook;
  private readonly runs;
  private readonly messages;
  private readonly campaigns;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.lorebook = new LorebookRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.messages = new MessageRepository(db);
    this.campaigns = new CampaignRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", claudeCodeBridgeUrl: "", claudeCodeBridgeSecret: "", deepseekApiKey: "", googleApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "" };
    const providers = new Map<string, EmbeddingProvider>();
    if (this.runtimeDefaults.openaiApiKey) providers.set("openai", new OpenAIEmbeddingProvider(this.runtimeDefaults.openaiApiKey));
    if (this.runtimeDefaults.googleApiKey) providers.set("google", new GoogleEmbeddingProvider(this.runtimeDefaults.googleApiKey));
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }) {
    const now = new Date().toISOString();
    try {
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }
      if (!run.sessionId) { this.runs.markCompleted(run.id, now, "no session — thread tracking skipped", null); this.runs.updateRun(run.id, { approvedAt: now }); return; }

      // Existing thread entries: the constant Index + the per-thread entries.
      const threadEntries = this.lorebook.listForCampaign(run.userId, run.campaignId, { tag: THREAD_TAG, limit: 200 });
      const indexEntry = threadEntries.find(e => e.name === INDEX_ENTRY_NAME && e.isConstant) ?? null;
      const priorThreads = this.parsePriorThreads(indexEntry?.comment ?? null);

      // Recent story turns (with scene dates) for change detection.
      const allMessages = this.messages.listForSession(run.userId, run.sessionId).filter(m => m.role !== "cold-start");
      const turnNumber = Math.max(1, Math.ceil(allMessages.length / 2));
      const currentDate = this.latestSceneDate(allMessages);
      const recent = allMessages.slice(-RECENT_TURN_WINDOW).map(m => `[${m.role}]: ${this.truncate(m.content, 2000)}`).join("\n\n");

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { trackerModel?: string; embeddingModel?: string } : {};
      const embedModelId = details.embeddingModel || DEFAULT_EMBED_MODEL;
      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, details.trackerModel || "claude-haiku-4-5-bridge")?.id ?? "claude-haiku-4-5-bridge";

      const priorBlock = priorThreads.length > 0
        ? priorThreads.map(t => JSON.stringify({ ...t, entryId: undefined })).join("\n")
        : "(none — this is the first run; bootstrap the tracker from the recent turns)";
      const userPrompt = `current_turn=${turnNumber}\ncurrent_in_world_date=${currentDate || "unknown"}\n\n<current_threads>\n${priorBlock}\n</current_threads>\n\n<recent_turns>\n${recent || "(no recent turns)"}\n</recent_turns>`;

      // Up to two attempts: a validation failure feeds the error back for a retry.
      let accepted: ThreadRecord[] | null = null;
      let lastError = "";
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        let responseText = "";
        const sys = attempt === 0 ? THREAD_TRACKER_SYSTEM : `${THREAD_TRACKER_SYSTEM}\n\nYOUR PREVIOUS OUTPUT WAS REJECTED: ${lastError}\nFix it and re-emit the COMPLETE thread list.`;
        await runtime.streamChat({
          modelId, systemPrompt: sys,
          messages: [{ role: "user", content: userPrompt, attachments: [] }],
          temperature: 0, thinkingMode: "off", thinkingBudget: null, effort: null, cacheTtl: "off",
          requestId: `thread-tracker-${run.id}-${attempt}`,
        }, { onStart: () => {}, onDelta: (d) => { responseText += d; }, onThinkingDelta: () => {}, onComplete: () => {} });

        const parsed = this.parseThreads(responseText);
        const verdict = this.validate(parsed, priorThreads);
        if (verdict.ok) accepted = parsed;
        else lastError = verdict.error;
      }

      if (!accepted) {
        // Failure-safe: never write a partial/corrupt tracker. Leave prior state untouched.
        this.logger.warn({ runId: run.id, lastError }, "thread tracker validation failed twice — prior tracker kept");
        this.runs.markCompleted(run.id, new Date().toISOString(), `Thread tracker unchanged (validation failed: ${lastError})`, JSON.stringify({ threads: priorThreads.length, written: false }));
        this.runs.updateRun(run.id, { approvedAt: new Date().toISOString() });
        return;
      }

      const written = this.commit(run.userId, run.campaignId, accepted, priorThreads, indexEntry, currentDate, turnNumber);
      if (written.embedTargets.length) {
        await this.embedding.indexEntries(written.embedTargets, embedModelId)
          .catch((err) => this.logger.warn({ runId: run.id, count: written.embedTargets.length, err }, "thread-tracker re-embed failed — vectors stale until backfill"));
      }
      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt,
        `Thread tracker: ${written.active} active, ${written.grace} in grace, ${written.graduated} graduated (${accepted.length} total)`,
        JSON.stringify({ threads: accepted.length, active: written.active, grace: written.grace, graduated: written.graduated, modelId }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "thread tracking failed", null);
    }
  }

  private parsePriorThreads(commentJson: string | null): ThreadRecord[] {
    if (!commentJson) return [];
    try {
      const parsed = JSON.parse(commentJson);
      const arr = Array.isArray(parsed?.threads) ? parsed.threads : [];
      return arr.filter((t: any) => t && typeof t.id === "string");
    } catch { return []; }
  }

  private parseThreads(text: string): ThreadRecord[] {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      const arr = Array.isArray(parsed?.threads) ? parsed.threads : [];
      return arr.map((t: any) => ({
        id: String(t?.id ?? "").trim(),
        title: String(t?.title ?? "").trim(),
        headline: String(t?.headline ?? "").trim(),
        status: String(t?.status ?? "").trim().toUpperCase(),
        openedDate: String(t?.openedDate ?? "").trim(),
        openedTurn: Number.isFinite(t?.openedTurn) ? Number(t.openedTurn) : 0,
        involved: Array.isArray(t?.involved) ? t.involved.map((x: any) => String(x).trim()).filter(Boolean) : [],
        summary: String(t?.summary ?? "").trim(),
        nextBeat: String(t?.nextBeat ?? "").trim(),
        pendingDates: String(t?.pendingDates ?? "").trim(),
        log: Array.isArray(t?.log) ? t.log.map((x: any) => String(x).trim()).filter(Boolean) : [],
        lastUpdatedDate: String(t?.lastUpdatedDate ?? "").trim(),
        lastUpdatedTurn: Number.isFinite(t?.lastUpdatedTurn) ? Number(t.lastUpdatedTurn) : 0,
      }));
    } catch { return []; }
  }

  /** Enforcement: full re-emission, carry-forward, schema, cap. */
  private validate(threads: ThreadRecord[], prior: ThreadRecord[]): { ok: true } | { ok: false; error: string } {
    if (threads.length === 0 && prior.length > 0) return { ok: false, error: "output had no threads but the current state has threads — full re-emission required" };
    const ids = new Set<string>();
    for (const t of threads) {
      if (!t.id) return { ok: false, error: "a thread is missing its id" };
      if (ids.has(t.id)) return { ok: false, error: `duplicate thread id ${t.id}` };
      ids.add(t.id);
      if (!VALID_STATUS.has(t.status)) return { ok: false, error: `thread ${t.id} has invalid status "${t.status}"` };
      if (PENDING_STATUS.has(t.status)) {
        if (!t.title) return { ok: false, error: `thread ${t.id} is missing a title` };
        if (!t.headline) return { ok: false, error: `thread ${t.id} is missing a headline` };
        if (!t.summary) return { ok: false, error: `thread ${t.id} is missing a summary` };
        if (!t.nextBeat) return { ok: false, error: `thread ${t.id} is missing a nextBeat` };
      }
    }
    // Carry-forward: every prior thread id must still appear.
    for (const p of prior) {
      if (!ids.has(p.id)) return { ok: false, error: `thread ${p.id} ("${p.title}") was silently dropped — every prior thread must appear, resolved or carried forward` };
    }
    const activeCount = threads.filter(t => PENDING_STATUS.has(t.status)).length;
    if (activeCount > MAX_ACTIVE_THREADS) return { ok: false, error: `${activeCount} non-resolved threads exceeds the cap of ${MAX_ACTIVE_THREADS} — resolve, abandon, or consolidate first` };
    return { ok: true };
  }

  /**
   * Atomically write the tracker.
   * - Pending + the GRACE_RESOLVED most-recently-resolved threads are the tracker working
   *   set: written as `threads` entries and listed in the constant index.
   * - Resolved threads older than the grace window GRADUATE: their entry re-tags
   *   threads -> events (rejoining the normal lorebook lifecycle — keyword-retrievable,
   *   archival-eligible) and they drop out of the index. This is the fall-off that keeps
   *   the index comment, the per-cycle re-emission, and the threads-tag count bounded.
   */
  private commit(userId: string, campaignId: string, threads: ThreadRecord[], prior: ThreadRecord[], indexEntry: any, currentDate: string, turnNumber: number) {
    const priorById = new Map(prior.map(p => [p.id, p]));
    const now = new Date().toISOString();

    const pending = threads.filter(t => PENDING_STATUS.has(t.status));
    const resolvedByRecency = threads
      .filter(t => !PENDING_STATUS.has(t.status))
      .sort((a, b) => (b.lastUpdatedTurn || 0) - (a.lastUpdatedTurn || 0));
    const grace = resolvedByRecency.slice(0, GRACE_RESOLVED);
    const graduating = resolvedByRecency.slice(GRACE_RESOLVED);
    const trackerThreads = [...pending, ...grace]; // the working set kept in the index

    // Entries whose content this run rewrites — collected for re-embedding AFTER the
    // transaction commits (indexEntries makes network calls; keep them out of the txn).
    // The constant Index entry is deliberately excluded — it's always in context and is
    // never semantically retrieved.
    const embedTargets: { id: string; userId: string; content: string }[] = [];

    this.lorebook.transact(() => {
      // Pending + grace-resolved -> `threads` entries (pending stay sticky).
      for (const t of trackerThreads) {
        const isPending = PENDING_STATUS.has(t.status);
        const priorEntryId = priorById.get(t.id)?.entryId;
        const content = this.renderThreadEntry(t);
        let entryId: string;
        if (priorEntryId && this.lorebook.findById(userId, priorEntryId)) {
          this.lorebook.update(userId, priorEntryId, {
            name: `Thread — ${t.title}`, tag: THREAD_TAG, content,
            keys: JSON.stringify(this.threadKeys(t)),
            isEnabled: 1, sticky: 0,
            tokensEstimate: estimateTokens(content), updatedAt: now,
          });
          entryId = priorEntryId;
        } else {
          entryId = this.createThreadEntry(userId, campaignId, t, THREAD_TAG, 0, now);
        }
        t.entryId = entryId;
        embedTargets.push({ id: entryId, userId, content });
      }

      // Graduated threads -> re-tag threads -> events; they leave the tracker.
      for (const t of graduating) {
        const priorEntryId = priorById.get(t.id)?.entryId;
        const content = this.renderThreadEntry(t);
        if (priorEntryId && this.lorebook.findById(userId, priorEntryId)) {
          this.lorebook.update(userId, priorEntryId, {
            name: `Thread — ${t.title}`, tag: "events", content,
            keys: JSON.stringify(this.threadKeys(t)),
            isEnabled: 1, sticky: 0, tokensEstimate: estimateTokens(content), updatedAt: now,
          });
          embedTargets.push({ id: priorEntryId, userId, content });
        } else {
          // Resolved past the grace window without ever having had an entry — rare;
          // create it directly as a concluded event.
          const newId = this.createThreadEntry(userId, campaignId, t, "events", 0, now);
          embedTargets.push({ id: newId, userId, content });
        }
        t.entryId = undefined;
      }

      // Regenerate the constant Thread Index. content = readable index for the LLM;
      // comment = canonical JSON. Both hold ONLY the working set (pending + grace).
      const indexContent = this.renderIndex(trackerThreads, currentDate, turnNumber);
      const indexComment = JSON.stringify({ threads: trackerThreads });
      if (indexEntry) {
        this.lorebook.update(userId, indexEntry.id, {
          content: indexContent, comment: indexComment,
          tokensEstimate: estimateTokens(indexContent), isConstant: 1, isEnabled: 1,
          preventRecursion: 1, updatedAt: now,
        });
      } else {
        this.lorebook.create({
          id: createId(), userId, campaignId,
          name: INDEX_ENTRY_NAME, tag: THREAD_TAG, content: indexContent,
          comment: indexComment, keys: "[]", keysSecondary: "[]",
          selectiveLogic: "and_any", scanDepth: 4, position: "before_main", insertionOrder: 12,
          probability: 100, isConstant: 1, isEnabled: 1,
          sticky: 0, cooldown: 0, delay: 0,
          excludeRecursion: 0, preventRecursion: 1, delayUntilRecursion: 0,
          tokensEstimate: estimateTokens(indexContent),
          knownBy: null, matchOptionsJson: null, legacySource: null,
          createdAt: now, updatedAt: now,
        });
      }
    });
    return { active: pending.length, grace: grace.length, graduated: graduating.length, embedTargets };
  }

  /** Create a per-thread lorebook entry; returns the new entry id. */
  private createThreadEntry(userId: string, campaignId: string, t: ThreadRecord, tag: string, sticky: number, now: string): string {
    const id = createId();
    const content = this.renderThreadEntry(t);
    this.lorebook.create({
      id, userId, campaignId,
      name: `Thread — ${t.title}`, tag, content,
      comment: `thread ${t.id}`,
      keys: JSON.stringify(this.threadKeys(t)), keysSecondary: "[]",
      selectiveLogic: "and_any", scanDepth: 6, position: "before_main", insertionOrder: 95,
      probability: 100, isConstant: 0, isEnabled: 1,
      sticky, cooldown: 0, delay: 0,
      excludeRecursion: 1, preventRecursion: 1, delayUntilRecursion: 0,
      tokensEstimate: estimateTokens(content),
      knownBy: null, matchOptionsJson: null, legacySource: null,
      createdAt: now, updatedAt: now,
    });
    return id;
  }

  private threadKeys(t: ThreadRecord): string[] {
    // Keys = the distinctive title (whole-phrase) so a reference pulls the full entry.
    // Deliberately NOT bare character names — those would false-positive and incur the PC penalty.
    const keys = new Set<string>([t.title]);
    // (Removed: adding the title's FIRST WORD as a key — that produced keys
    // like "The" or "Serena's" that keyword-activated the full thread entry on
    // virtually every turn, defeating the whole-phrase intent above.)
    return [...keys].filter(Boolean);
  }

  private renderThreadEntry(t: ThreadRecord): string {
    const lines = [
      `THREAD ${t.id} — ${t.title} [${t.status}]`,
      `Opened: ${t.openedDate || "?"}${t.openedTurn ? ` (turn ${t.openedTurn})` : ""} · Last update: ${t.lastUpdatedDate || "?"}`,
      `Involved: ${t.involved.join(", ") || "—"}`,
      ``,
      t.summary,
    ];
    if (PENDING_STATUS.has(t.status) && t.nextBeat) lines.push(``, `Next: ${t.nextBeat}`);
    if (t.pendingDates) lines.push(`Pending dates: ${t.pendingDates}`);
    if (t.log.length > 0) lines.push(``, `Chronology:`, ...t.log.map(l => `- ${l}`));
    return lines.join("\n");
  }

  private renderIndex(threads: ThreadRecord[], currentDate: string, turnNumber: number): string {
    const pending = threads.filter(t => PENDING_STATUS.has(t.status));
    // `threads` is the working set (pending + grace), so closed is already
    // bounded by GRACE_RESOLVED and ordered most-recently-resolved first.
    const closed = threads.filter(t => !PENDING_STATUS.has(t.status));
    const lines = [
      `CAMPAIGN THREAD TRACKER — index of every pending narrative thread.`,
      `As of ${currentDate || "current scene"} (turn ${turnNumber}). ${pending.length} active thread${pending.length === 1 ? "" : "s"}.`,
      `Each line is a pointer: when the story touches a thread, its full uncompressed entry loads into context. Do not treat these one-liners as the full picture — reference a thread by name to pull its detail.`,
      ``,
    ];
    for (const t of pending) {
      lines.push(`[${t.id}] ${t.title} — ${t.headline} — ${t.status}${t.pendingDates ? ` — ${t.pendingDates}` : ""}`);
    }
    if (closed.length > 0) {
      lines.push(``, `Recently closed:`);
      for (const t of closed) lines.push(`[${t.id}] ${t.title} — ${t.status}`);
    }
    return lines.join("\n");
  }

  private latestSceneDate(messages: Array<{ role: string; sceneData?: string | null }>): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as any;
      if (m.role === "assistant" && m.sceneData) {
        try {
          const scene = JSON.parse(m.sceneData);
          if (scene?.date) return String(scene.date);
        } catch {}
      }
    }
    return "";
  }

  private truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + "…";
  }
}
