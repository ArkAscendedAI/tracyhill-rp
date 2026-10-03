import { pipelineInputsForRun } from "./settledSourceGuard";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { THREAD_INDEX_ENTRY_NAME, THREADS_TAG } from "@tracyhill-rp/contracts";
import { createDatabaseClient, migrateDatabase, type DatabaseClient } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, withTimeout, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { resolveCampaignEmbedModel } from "../../../api/src/domain/context/embedModelResolver";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { stripOocBlocks } from "../../../api/src/domain/context/stripOoc";
import { EPISTEMIC_STATUS_RULE } from "./epistemicStatus";
import { resolveWorkerModel } from "./workerModel";
import { canonSourceVersion } from "./canonSourceVersion";
import { workerTurnNumber } from "./turnOrdinal";
import { completeRun } from "./runCompletion";
import { latestCoverageMarker, planPasses, readCoverageMarker, selectSpan, type PassCaps } from "./transcriptSpan";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";

// The Thread Index is a single CONSTANT lorebook entry — always in context. It carries
// one descriptive line per active thread (no detail). preventRecursion stops its content
// from cascading activations. Identified by this exact name + tag, defined once in the
// contracts and shared with the repository's findThreadIndex, the
// drive worker, the world tick and the web.
export const INDEX_ENTRY_NAME = THREAD_INDEX_ENTRY_NAME;
export const THREAD_TAG = THREADS_TAG;
const MAX_ACTIVE_THREADS = 80;
// Fall-off: a resolved/abandoned thread stays in the tracker for this many of the
// most-recently-resolved slots (short-term continuity). Older resolved threads GRADUATE —
// they leave the tracker and their entry re-tags threads -> events. This keeps the index
// comment, the per-cycle re-emission, and the threads-tag entry count bounded.
const GRACE_RESOLVED = 10;
// Spans: a run reads every settled message since the
// previous tracker run of its session, whole, in passes of whole exchanges. The
// caps match the rolling diff's (48 messages / 80,000 characters: the usual
// span between two runs is one pass, see DIFF_PASS_CAPS); the tracker's fixed
// cost is the ledger (about 100k characters on a long campaign). A session's first
// run, or the first after legacy runs without a coverage marker, reads the last
// twelve messages, whole (they used to be cut to 2,000 characters each).
export const TRACKER_PASS_CAPS: PassCaps = { maxMessages: 48, maxChars: 80_000 };
const TRACKER_FALLBACK_WINDOW = 12;

/** A transcript message as the tracker renders it (OOC stripped, never cut). */
export function renderTrackerMessage(m: { role: string; content: string }): string {
  return `[${m.role}]: ${stripOocBlocks(m.content)}`;
}

/** One pass of a run, as its details record it. */
export interface TrackerPassRecord { fromSortOrder: number; throughSortOrder: number; messages: number; chars: number; changed: number }

/** The fields of a tracker run's details this worker reads. */
interface TrackerRunDetails {
  trackerModel?: string;
  embeddingModel?: string;
  workerEffort?: string;
  openaiFastMode?: boolean;
  coveredFromSortOrder?: number;
  coveredThroughSortOrder?: number;
  coveredReadAt?: string;
  passes?: TrackerPassRecord[];
}
// Field caps (2026-09-25). The prompt has asked for "1-3 sentences" since day one and
// the model never obeyed it under accretion: on one long campaign a single thread's summary
// reached 21,733 chars, 29 threads carried 197k chars of summaries, and the eight
// largest thread ENTRIES (47,675 estimator tokens) outweighed the campaign's whole
// 42k retrieval budget by themselves — every scored entry was dropped for weeks.
// Caps are enforced in code: an over-cap changed record is rejected with the field
// named (the re-ask shortens it); if the second attempt is still over cap on caps
// ALONE, the record is compacted in code (sentence-boundary cut) rather than
// freezing the tracker (the 2026-07-13 paralysis class). Logs and involved lists are
// normalized in code every run. The index line shows a bounded pending-dates tail.
export const THREAD_FIELD_CAPS = Object.freeze({
  headline: 200,
  summary: 700,
  nextBeat: 240,
  pendingDates: 320,
  logLines: 10,
  logLine: 240,
  involved: 14,
  indexPendingDates: 160,
});
// Threads activate via keyword/semantic/researcher — no sticky carry-over (was THREAD_STICKY, fixed at 0 since 2026-05-26).

const THREAD_TRACKER_SYSTEM = `You maintain the THREAD TRACKER for an ongoing roleplay campaign — the canonical, dynamic record of every pending narrative thread (quests, operations, mysteries, promises, unresolved tensions, plans-in-motion).

You will receive the CURRENT tracker state (all existing threads) and the most recent story turns. Output ONLY THE DELTA as JSON — the threads the recent turns actually moved, plus the ids of everything else:

{"changed": [ <full thread objects> ], "unchangedIds": ["T01", "T07", ...]}

"changed" holds every thread the recent turns touched (progressed / stalled / resolved / abandoned / merged), every NEW thread, each as a COMPLETE object. "unchangedIds" lists every other existing thread id — the server carries those forward byte-identical. (Delta emission replaced full re-emission 2026-07-13: re-emitting a mature campaign's whole tracker every run outgrows any output budget. Lines like [GM SPOTLIGHT — Name] in the turns are author meta-directives, not story events — ignore them.)

WHAT IS A THREAD: a pending narrative obligation the story must eventually pay off. Examples: "rescue the captured villager", "the SOC must be staffed", "Vale's long-term fate must be decided", "Corin promised to teach Bram the attunement". NOT a thread: a concluded scene, a static fact, a character trait — those belong in the regular lorebook. NOT a thread: a single character's personal near-term want or feeling ("Sofia wants to get Corin alone", "Wilkins resents the Council") — that is tracked separately on the character's drive sheet. Threads are PLOT (multi-scene, often multi-party obligations); leave individual psychology to the drive sheets.

For EACH thread in "changed" output an object:
{
  "id": "T03",                       // stable — NEVER renumber an existing thread; reuse its id
  "title": "Vale's disposition",   // short, distinctive, stable
  "headline": "Fallen primordial held in S6; Corin deciding her long-term fate",  // <= 18 words / 200 characters, descriptive — this is the one-line index entry
  "status": "ACTIVE",                // OPEN (just introduced) | ACTIVE (being worked) | STALLED (blocked/waiting) | RESOLVED (concluded) | ABANDONED (dropped, will not pay off)
  "openedDate": "Sept 30, 1998",     // in-world date the thread began
  "openedTurn": 2180,
  "involved": ["Corin", "Mara", "Bram", "Vale"],
  "summary": "2-4 sentences, HARD CAP 700 characters: what the thread IS and where it currently stands.",
  "nextBeat": "1 sentence, HARD CAP 240 characters: the concrete next thing that must happen.",
  "pendingDates": "Bram translation due ~Oct 5",  // deadlines / scheduled beats / due dates, or "" if none — HARD CAP 320 characters
  "log": ["Sept 30 — opened: Vale captured, placed in S6", "Oct 2 — four-person cell visit"],  // append-only dated chronology — the opened line + the most recent 9, each <= 240 characters
  "lastUpdatedDate": "Oct 2, 1998",
  "lastUpdatedTurn": 2204
}

HARD RULES — these are enforced; violating them rejects your output:

1. COMPLETE COVERAGE. Every thread id in the current state MUST appear exactly once — either as a full object in "changed" or as an id in "unchangedIds". A missing or doubled id is a failure. Never drop a thread silently: a thread that is no longer pending goes in "changed" with status RESOLVED or ABANDONED and a final log line.

2. UNCHANGED MEANS UNTOUCHED. List a thread in "unchangedIds" ONLY when the recent turns did not move it at all. If it progressed, stalled, resolved, or its nextBeat/pendingDates shifted, it belongs in "changed" as a FULL object.

3. FULL OBJECTS IN "changed". A changed thread re-emits its complete record — every field, the full log with the new development(s) appended. Never a partial object, never a bare diff.

4. STABLE IDS. Reuse each thread's existing id. New threads get the next free id (T<N>). Never renumber.

5. DATED CHRONOLOGY. Every status change or material development appends a log line dated with the in-world date it happened (read the recent turns' scene metadata for dates). If multiple developments happened since the last run, log each. The opened-date log line is never removed.

6. REQUIRED DETAIL. Every non-resolved changed thread MUST have a non-empty headline, summary, and nextBeat. headline must be descriptive enough to inform on its own.

7. OPEN NEW THREADS. If the recent turns introduce a new pending obligation, open a thread for it in "changed" (status OPEN). If the current state is empty, bootstrap: every thread is new, "unchangedIds" is empty.

8. CONSOLIDATE, never lossy-compress. If two threads are genuinely facets of one arc, keep the lower id in "changed" with the other's log folded in — and put the absorbed thread in "changed" too, status ABANDONED with a log line noting the merge. Do NOT summarize away detail from a single thread.

9. CAP: at most ${MAX_ACTIVE_THREADS} non-resolved threads across changed + unchanged. If you would exceed it, RESOLVE, ABANDON, or consolidate first.

10. log: keep the opened line + the most recent ~8 lines per changed thread; if older lines must go, fold their substance into the summary first.

11. PARSIMONY WITH JUDGMENT. A typical run changes 1–5 threads. Re-emitting threads the turns never touched defeats the delta design — but correctness beats parsimony: when unsure whether a thread moved, put it in "changed".

12. COMPACT FIELDS — enforced in code, over-cap output is rejected: summary <= 700 characters, nextBeat <= 240, pendingDates <= 320, headline <= 200; log = the opened line plus at most 9 more, each <= 240 characters. A summary is a standing description of the thread NOW, not a running narrative: when you touch a thread whose summary is over the cap, REWRITE it compactly from scratch — the chronology carries the history, the full lorebook carries the detail. Never append to an over-cap field.

13. SETTLED IS NOT PENDING. When the record shows a thing is gone, lost, destroyed, answered, delivered, dead, or refused and accepted, it is a closed fact: state it once in the summary as closed ("the duffel is gone; loss accepted Sept 9") and never carry it in pendingDates or nextBeat as an open ask, a standing refusal, or a question to raise again. A character may still grieve it on the page; the tracker does not keep re-asking, and neither do the sheets that read it.
${EPISTEMIC_STATUS_RULE}

An event that did not happen in baseline reality does not move a thread on its own. A death inside a vision does not RESOLVE the thread that character carried, and does not open an avenge-them thread. What such an event DOES move is what the people who experienced it now believe and will act on — log that, and state plainly in the log line that the event was a projection, an illusion, or a claim.

Output ONLY a JSON object: {"changed": [...], "unchangedIds": [...]}. No prose, no markdown fences.`;

export interface ThreadRecord {
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
export const PENDING_STATUS = new Set(["OPEN", "ACTIVE", "STALLED"]);

/** The ledger changed between the run's read and its commit. */
export class TrackerLedgerChangedError extends Error {
  constructor(readonly entryIds: string[]) {
    super(`thread tracker ledger changed during the run: ${entryIds.join(", ")}`);
    this.name = "TrackerLedgerChangedError";
  }
}

// ── Delta contract (2026-07-13 redesign) ────────────────────────────────────
// Full re-emission scaled O(campaign length) in OUTPUT tokens: at 55 threads
// (~332KB ≈ 85K tokens) every run blew the 30-minute worker deadline or came
// back truncated, freezing the tracker for 3 days. The
// model now emits only the threads the recent turns moved plus the ids of
// everything else; the server carries unchanged threads forward verbatim.
// Exported standalone (driveUpdateWorker pattern) for direct unit testing.

export interface TrackerDelta {
  changed: ThreadRecord[];
  unchangedIds: string[];
}

function mapThreadRecord(t: any): ThreadRecord {
  return {
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
  };
}

/** The prior ledger from the index entry's comment JSON, every record
 *  normalized through `mapThreadRecord`: a hand-curated record
 *  missing `log`/`involved` used to reach `renderThreadEntry` raw and fail every
 *  run with "Cannot read properties of undefined (reading 'join')" naming
 *  nothing. `entryId` (assigned by this worker, not the model) is preserved. */
export function parsePriorThreadRecords(commentJson: string | null): ThreadRecord[] {
  if (!commentJson) return [];
  try {
    const parsed = JSON.parse(commentJson);
    const arr = Array.isArray(parsed?.threads) ? parsed.threads : [];
    return arr
      .filter((t: any) => t && typeof t.id === "string" && t.id.trim())
      .map((t: any) => ({ ...mapThreadRecord(t), entryId: typeof t.entryId === "string" && t.entryId ? t.entryId : undefined }));
  } catch { return []; }
}

export function parseTrackerDelta(text: string): TrackerDelta {
  // First balanced {…} object, tolerating preamble/trailing content the model
  // emits around it.
  const parsed = parseFirstJson<{ changed?: unknown[]; unchangedIds?: unknown[] }>(text, "{");
  const changed = Array.isArray(parsed?.changed) ? parsed!.changed!.map(mapThreadRecord) : [];
  const unchangedIds = Array.isArray(parsed?.unchangedIds)
    ? parsed!.unchangedIds!.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return { changed, unchangedIds };
}

/** Cut a string at the cap on a sentence boundary when one exists in the back half,
 *  otherwise on a word boundary; marks the cut with an ellipsis. Exported for tests. */
export function cutAtCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const room = Math.max(0, cap - 2);
  const head = text.slice(0, room);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf(".\n"));
  const cut = sentenceEnd >= Math.floor(room / 2) ? sentenceEnd + 1 : (head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : room);
  return `${head.slice(0, cut).trimEnd()} …`;
}

/** Log and involved lists are normalized on EVERY accepted record (lossless per
 *  the prompt's own rule 10): the opened line + the most recent N-1, each line
 *  bounded. Exported for tests and the compaction tool. */
export function normalizeThreadLists(t: ThreadRecord): ThreadRecord {
  const caps = THREAD_FIELD_CAPS;
  let log = t.log.map((l) => cutAtCap(l, caps.logLine));
  if (log.length > caps.logLines) log = [log[0]!, ...log.slice(log.length - (caps.logLines - 1))];
  return { ...t, log, involved: t.involved.slice(0, caps.involved) };
}

/** Code-side compaction for the fallback path: every string field cut to its cap.
 *  Used only after the model failed the caps twice — the tracker keeps moving,
 *  and the system event names what was cut. Exported for tests and the tool. */
export function compactThreadRecord(t: ThreadRecord): ThreadRecord {
  const caps = THREAD_FIELD_CAPS;
  return normalizeThreadLists({
    ...t,
    headline: cutAtCap(t.headline, caps.headline),
    summary: cutAtCap(t.summary, caps.summary),
    nextBeat: cutAtCap(t.nextBeat, caps.nextBeat),
    pendingDates: cutAtCap(t.pendingDates, caps.pendingDates),
  });
}

/** The fields the caps govern, with their current overrun (0 = within cap). */
export function threadFieldOverruns(t: ThreadRecord): Array<{ field: string; length: number; cap: number }> {
  const caps = THREAD_FIELD_CAPS;
  const checks: Array<[string, string, number]> = [["summary", t.summary, caps.summary], ["nextBeat", t.nextBeat, caps.nextBeat], ["pendingDates", t.pendingDates, caps.pendingDates], ["headline", t.headline, caps.headline]];
  return checks.filter(([, value, cap]) => value.length > cap).map(([field, value, cap]) => ({ field, length: value.length, cap }));
}

/** Enforcement: complete coverage, no doubling, schema on changed, merged cap, field caps.
 *  `kind` tells the run loop which failures may fall back to code compaction: only
 *  "caps" — coverage and schema failures still hold the prior ledger. */
export function validateTrackerDelta(delta: TrackerDelta, prior: ThreadRecord[]): { ok: true } | { ok: false; error: string; kind: "coverage" | "schema" | "caps" } {
  const priorIds = new Set(prior.map((p) => p.id));
  if (delta.changed.length === 0 && delta.unchangedIds.length === 0 && prior.length > 0) {
    return { ok: false, kind: "coverage", error: "output had no threads but the current state has threads — complete coverage required" };
  }
  const seen = new Set<string>();
  for (const t of delta.changed) {
    if (!t.id) return { ok: false, kind: "schema", error: "a changed thread is missing its id" };
    if (seen.has(t.id)) return { ok: false, kind: "coverage", error: `thread id ${t.id} appears more than once` };
    seen.add(t.id);
    if (!VALID_STATUS.has(t.status)) return { ok: false, kind: "schema", error: `thread ${t.id} has invalid status "${t.status}"` };
    if (PENDING_STATUS.has(t.status)) {
      if (!t.title) return { ok: false, kind: "schema", error: `thread ${t.id} is missing a title` };
      if (!t.headline) return { ok: false, kind: "schema", error: `thread ${t.id} is missing a headline` };
      if (!t.summary) return { ok: false, kind: "schema", error: `thread ${t.id} is missing a summary` };
      if (!t.nextBeat) return { ok: false, kind: "schema", error: `thread ${t.id} is missing a nextBeat` };
    }
  }
  for (const id of delta.unchangedIds) {
    if (seen.has(id)) return { ok: false, kind: "coverage", error: `thread id ${id} appears in both changed and unchangedIds` };
    seen.add(id);
    if (!priorIds.has(id)) return { ok: false, kind: "coverage", error: `unchangedIds lists ${id}, which does not exist in the current state` };
  }
  for (const p of prior) {
    if (!seen.has(p.id)) return { ok: false, kind: "coverage", error: `thread ${p.id} ("${p.title}") was silently dropped — every current thread must appear in changed or unchangedIds` };
  }
  const merged = mergeTrackerDelta(delta, prior);
  const activeCount = merged.filter((t) => PENDING_STATUS.has(t.status)).length;
  if (activeCount > MAX_ACTIVE_THREADS) return { ok: false, kind: "schema", error: `${activeCount} non-resolved threads exceeds the cap of ${MAX_ACTIVE_THREADS} — resolve, abandon, or consolidate first` };
  // Field caps LAST: a caps failure therefore implies coverage and schema passed,
  // which is what licenses the run loop's code-compaction fallback.
  const overruns = delta.changed.flatMap((t) => threadFieldOverruns(t).map((o) => `${t.id}.${o.field} is ${o.length} characters (cap ${o.cap})`));
  if (overruns.length > 0) return { ok: false, kind: "caps", error: `FIELD CAPS: ${overruns.join("; ")} — rewrite each over-cap field compactly (the chronology carries the history); never append to it` };
  return { ok: true };
}

/**
 * Merge: unchanged threads carry forward from the prior ledger verbatim
 * (including their entryId); changed threads inherit their prior entryId by id.
 */
export function mergeTrackerDelta(delta: TrackerDelta, prior: ThreadRecord[]): ThreadRecord[] {
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const changedIds = new Set(delta.changed.map((t) => t.id));
  const carried = prior.filter((p) => !changedIds.has(p.id));
  const changed = delta.changed.map((t) => ({ ...normalizeThreadLists(t), entryId: priorById.get(t.id)?.entryId }));
  return [...carried, ...changed];
}

export class ThreadTrackerWorker {
  private readonly logger = createLogger("thread-tracker-worker");
  private readonly lorebook;
  private readonly runs;
  private readonly messages;
  private readonly sessions;
  private readonly campaigns;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;
  private readonly db: DatabaseClient["db"];

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.db = db;
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.runs = new PipelineRunRepository(db);
    this.messages = new MessageRepository(db);
    this.sessions = new SessionRepository(db);
    this.campaigns = new CampaignRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    const providers = buildEmbeddingProviders(this.runtimeDefaults);
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    // Scoped revision context: restored after the run settles.
    return this.lorebook.withRevisionContext({ source: "thread_tracker", pipelineRunId: run.id }, () => this.executeInContext(run, signal));
  }

  private async executeInContext(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const now = new Date().toISOString();
    // Passes whose ledger writes have committed: a cancel or a
    // failure after one of them leaves those writes standing.
    const committed: TrackerPassRecord[] = [];
    let passCount = 0;
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }
      if (!run.sessionId) { completeRun(this.runs, run.id, now, "no session — thread tracking skipped", null); return; }
      const sessionId = run.sessionId;

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as TrackerRunDetails : {};
      // Session dial via detailsJson; fallback = the API's newest-session rule.
      const embedModelId = details.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);

      // A corrupt index comment must NOT silently reset the ledger (which
      // orphans every per-thread entry — archival protects the tag, rolling diff
      // won't touch it, the tracker only updates entries it has ids for). Only a
      // genuine JSON parse FAILURE counts as corruption; a valid empty ledger
      // (e.g. {"threads":[]}) is fine and should bootstrap normally.
      const readLedger = () => {
        // Existing thread entries: the constant Index + the per-thread entries.
        // The index is fetched by name and constancy (findThreadIndex),
        // never by its place in a recency window; its version joins the others.
        const indexEntry = this.lorebook.findThreadIndex(run.userId, run.campaignId) ?? null;
        const listed = this.lorebook.listForCampaign(run.userId, run.campaignId, { tag: THREAD_TAG, limit: 200 });
        const threadEntries = indexEntry && !listed.some((e) => e.id === indexEntry.id) ? [indexEntry, ...listed] : listed;
        return { threadEntries, indexEntry, rawIndexComment: indexEntry?.comment ?? null };
      };
      const initial = readLedger();
      if (initial.rawIndexComment && initial.rawIndexComment.trim()) {
        try { JSON.parse(initial.rawIndexComment); }
        catch {
          recordSystemEvent({
            userId: run.userId, source: "thread_tracker", severity: "error",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: "thread tracker index comment is unparseable — refusing to reset the ledger (possible corruption)",
            details: { head: initial.rawIndexComment.slice(0, 200) },
          });
          this.runs.markFailed(run.id, now, "thread tracker index comment unparseable — ledger not reset", null);
          return;
        }
      }

      // The span: every settled message after the point the
      // previous tracker run of this session reached, read in passes, every
      // message whole. It used to be the last twelve, each cut to 2,000
      // characters (on 2026-09-07 a 17.7k-character message was read as its
      // first 2,000 characters). A session's first run, or the first after
      // legacy runs without a marker, reads the last twelve, whole.
      const allMessages = inputs.readSession(sessionId).filter(m => m.role !== "cold-start");
      const readAt = new Date().toISOString();
      const ownMarker = readCoverageMarker(details);
      const previous = ownMarker ?? latestCoverageMarker(this.db, { userId: run.userId, campaignId: run.campaignId, sessionId, kind: "thread_tracker", excludeRunId: run.id });
      const span = selectSpan(allMessages, previous, TRACKER_FALLBACK_WINDOW);
      const passes = planPasses(span.rows, TRACKER_PASS_CAPS, (row) => renderTrackerMessage(row).length);
      passCount = passes.length;
      const earlierPasses = ownMarker && Array.isArray(details.passes) ? details.passes : [];
      /** Where the input reached if the run stops now: the last committed pass,
       *  else the previous marker (the next run re-reads this span), else just
       *  before this run's first message. */
      const coverageSoFar = () => committed.length > 0
        ? { coveredThroughSortOrder: committed[committed.length - 1]!.throughSortOrder, coveredReadAt: readAt }
        : previous ? { coveredThroughSortOrder: previous.throughSortOrder, coveredReadAt: previous.readAt }
        : span.rows.length > 0 ? { coveredThroughSortOrder: span.rows[0]!.sortOrder - 1, coveredReadAt: readAt } : {};
      if (passes.length === 0) {
        completeRun(this.runs, run.id, now, "Thread tracker unchanged (no new settled messages since its previous run)", JSON.stringify({
          threads: parsePriorThreadRecords(initial.rawIndexComment).length, written: false, spanMode: span.mode, passes: earlierPasses,
          ...(previous ? { coveredThroughSortOrder: previous.throughSortOrder, coveredReadAt: readAt } : {}),
        }));
        return;
      }
      const coveredFromSortOrder = ownMarker && Number.isInteger(details.coveredFromSortOrder) ? details.coveredFromSortOrder! : passes[0]![0]!.sortOrder;

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // An unresolvable trackerModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "thread_tracker", "thread tracker", details.trackerModel, getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      let lastStats: { threads: number; changed: number; active: number; grace: number; graduated: number } | null = null;
      const skipped: TrackerPassRecord[] = [];
      for (const [passIndex, passRows] of passes.entries()) {
        const isLast = passIndex === passes.length - 1;
        const tag = passes.length > 1 ? `-pass${passIndex + 1}` : "";
        const passEnd = passRows[passRows.length - 1]!.sortOrder;
        const passRecord: TrackerPassRecord = { fromSortOrder: passRows[0]!.sortOrder, throughSortOrder: passEnd, messages: passRows.length, chars: 0, changed: 0 };

        // The ledger as it stands now: each pass reads the previous pass's commit.
        const { threadEntries, indexEntry, rawIndexComment } = passIndex === 0 ? initial : readLedger();
        const priorThreads = this.parsePriorThreads(rawIndexComment);
        // Ledger versions as READ: the owner hand-curates
        // the constant index and per-thread entries; a rewrite authored against a
        // ledger read minutes earlier must not overwrite an edit that landed
        // during the model call. Compared inside commit()'s transaction.
        const ledgerVersions = new Map(threadEntries.map((e) => [e.id, canonSourceVersion(e)]));

        // The engine's turn: the settling message for the last pass; for an
        // earlier pass, the user message that followed its last reply.
        const turnNumber = isLast
          ? workerTurnNumber(this.messages, run.userId, sessionId, inputs.source)
          : workerTurnNumber(this.messages, run.userId, sessionId, inputs.source, passes[passIndex + 1]![0]!.sortOrder);
        const currentDate = this.latestSceneDate(allMessages.filter((m) => m.sortOrder <= passEnd));
        // Canon writer: OOC planning text is stripped (see stripOoc.ts).
        const recent = passRows.map(renderTrackerMessage).join("\n\n");
        passRecord.chars = recent.length;

        const priorBlock = priorThreads.length > 0
          ? priorThreads.map(t => JSON.stringify({ ...t, entryId: undefined })).join("\n")
          : "(none — this is the first run; bootstrap the tracker from the recent turns)";
        const userPrompt = `current_turn=${turnNumber}\ncurrent_in_world_date=${currentDate || "unknown"}\n\n<current_threads>\n${priorBlock}\n</current_threads>\n\n<recent_turns>\n${recent || "(no recent turns)"}\n</recent_turns>`;

        // Up to two attempts: a validation failure feeds the error back for a retry.
        let acceptedDelta: TrackerDelta | null = null;
        let lastError = "";
        let lastParsed: TrackerDelta | null = null;
        let lastKind: "coverage" | "schema" | "caps" | null = null;
        for (let attempt = 0; attempt < 2 && !acceptedDelta; attempt++) {
          let responseText = "";
          const sys = attempt === 0 ? THREAD_TRACKER_SYSTEM : `${THREAD_TRACKER_SYSTEM}\n\nYOUR PREVIOUS OUTPUT WAS REJECTED: ${lastError}\nFix it and re-emit the delta with complete coverage.`;
          this.runs.heartbeat(run.id);
          await withDeadline(WORKER_LLM_DEADLINE_MS, "thread-tracker model call", (dl) => withRetry(() => runtime.streamChat({
            modelId, systemPrompt: sys,
            messages: [{ role: "user", content: userPrompt, attachments: [] }],
            temperature: 0, thinkingMode: workerThinkingModeFor(modelId, workerEffort), thinkingBudget: null, effort: workerEffort, cacheTtl: "off", speed,
            requestId: `thread-tracker-${run.id}${tag}-${attempt}`,
            signal: dl,
          }, { onStart: () => {}, onDelta: (d) => { responseText += d; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { responseText = ""; }, signal), signal);

          const parsed = parseTrackerDelta(responseText);
          const verdict = validateTrackerDelta(parsed, priorThreads);
          if (verdict.ok) acceptedDelta = parsed;
          else { lastError = verdict.error; lastParsed = parsed; lastKind = verdict.kind; }
        }

        // Caps fallback (2026-09-25): coverage and schema passed twice and only the
        // field caps failed — compact in code and keep the tracker moving. The cut
        // is loud (system event naming the fields) and never silent.
        if (!acceptedDelta && lastParsed && lastKind === "caps") {
          const cutFields = lastParsed.changed.flatMap((t) => threadFieldOverruns(t).map((o) => `${t.id}.${o.field} ${o.length}→${o.cap}`));
          const compacted: TrackerDelta = { changed: lastParsed.changed.map(compactThreadRecord), unchangedIds: lastParsed.unchangedIds };
          if (validateTrackerDelta(compacted, priorThreads).ok) {
            acceptedDelta = compacted;
            recordSystemEvent({
              userId: run.userId, source: "thread_tracker", severity: "warn",
              campaignId: run.campaignId, sessionId: run.sessionId,
              message: "thread tracker compacted over-cap fields in code after two rejected outputs — review the cut threads in Behind the Curtain",
              details: { runId: run.id, cutFields },
            });
          }
        }

        if (!acceptedDelta) {
          // Failure-safe: never write a partial/corrupt tracker. The ledger stays
          // as it is for this pass's turns and the run moves on to the next pass,
          // so the tracker never freezes on one span (the 2026-07-13 paralysis
          // class); the event names the span for review. No-silent-failures: this
          // used to only pino-warn, so repeated tracker paralysis never reached
          // the events surface.
          this.logger.warn({ runId: run.id, lastError, pass: passIndex + 1 }, "thread tracker validation failed twice — prior tracker kept for this pass");
          recordSystemEvent({
            userId: run.userId, source: "thread_tracker", severity: "warn",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `thread tracker validation failed twice (${lastError}) — threads not updated from ${passRows.length} messages${passes.length > 1 ? ` (pass ${passIndex + 1} of ${passes.length})` : " this run"}`,
            details: { runId: run.id, fromSortOrder: passRecord.fromSortOrder, throughSortOrder: passEnd, error: lastError },
          });
          skipped.push(passRecord);
          if (isLast) {
            completeRun(this.runs, run.id, new Date().toISOString(), `Thread tracker unchanged (validation failed: ${lastError})`, JSON.stringify({
              threads: priorThreads.length, written: committed.length > 0, ...(lastStats ?? {}), modelId,
              coveredFromSortOrder, coveredThroughSortOrder: passEnd, coveredReadAt: readAt, spanMode: span.mode, passes: [...earlierPasses, ...committed], skippedPasses: skipped,
            }));
            return;
          }
          continue;
        }

        const accepted = mergeTrackerDelta(acceptedDelta, priorThreads);
        const changedIds = new Set(acceptedDelta.changed.map((t) => t.id));
        passRecord.changed = changedIds.size;
        // Terminal status commits WITH the ledger: the
        // completed row and the thread/index writes are one transaction — a
        // cancel that lands after the model call (the API marks the row
        // canceled directly in the split topology) rolls the writes back instead
        // of leaving a rewritten ledger under a "canceled" row, and an unclean
        // stop cannot requeue a run whose writes already landed. An earlier pass
        // commits with its progress marker instead. The re-embed stays
        // best-effort after the commit.
        const doneAt = new Date().toISOString();
        let written: ReturnType<ThreadTrackerWorker["commit"]>;
        try {
          written = this.commit(run.userId, run.campaignId, accepted, priorThreads, indexEntry, currentDate, turnNumber, changedIds, assertSource, ledgerVersions, (stats) => {
            lastStats = { threads: accepted.length, changed: changedIds.size, active: stats.active, grace: stats.grace, graduated: stats.graduated };
            const coverage = { coveredFromSortOrder, coveredThroughSortOrder: passEnd, coveredReadAt: readAt, spanMode: span.mode, passes: [...earlierPasses, ...committed, passRecord], ...(skipped.length > 0 ? { skippedPasses: skipped } : {}) };
            if (!isLast) {
              this.recordPassProgress(run, details, coverage);
              return;
            }
            const completed = this.runs.markCompleted(run.id, doneAt,
              `Thread tracker: ${changedIds.size} changed, ${stats.active} active, ${stats.grace} in grace, ${stats.graduated} graduated (${accepted.length} total)${passes.length > 1 ? ` in ${passes.length} passes` : ""}`,
              JSON.stringify({ ...lastStats, modelId, ...coverage }));
            if (!completed) throw new DOMException("thread tracker canceled before its writes committed", "AbortError");
            this.runs.updateRun(run.id, { approvedAt: doneAt });
          });
        } catch (error) {
          if (!(error instanceof TrackerLedgerChangedError)) throw error;
          // Held, not failed: the owner's edit stands and the next run reads it,
          // together with this pass's turns (the marker stays before them).
          this.logger.warn({ runId: run.id, entryIds: error.entryIds }, "thread tracker held its rewrite — the ledger was edited during the run");
          recordSystemEvent({
            userId: run.userId, source: "thread_tracker", severity: "info",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `thread tracker held its rewrite: ${error.entryIds.length} ledger entr${error.entryIds.length === 1 ? "y was" : "ies were"} edited during the run (your edit stands; the next run reads it)`,
            details: { runId: run.id, entryIds: error.entryIds },
          });
          completeRun(this.runs, run.id, new Date().toISOString(), "Thread tracker unchanged (ledger edited during the run — your edit stands)", JSON.stringify({
            threads: priorThreads.length, written: committed.length > 0, heldEntryIds: error.entryIds, modelId,
            ...(coverageSoFar()), coveredFromSortOrder, spanMode: span.mode, passes: [...earlierPasses, ...committed],
          }));
          return;
        }
        committed.push(passRecord);
        if (written.embedTargets.length) {
          await withTimeout(this.embedding.indexEntries(written.embedTargets, embedModelId), WORKER_LLM_DEADLINE_MS, "thread-tracker re-embed")
            .catch((err) => {
              // The hung-embed (withTimeout) path is not covered by
              // indexEntries' own provider-error events.
              this.logger.warn({ runId: run.id, count: written.embedTargets.length, err }, "thread-tracker re-embed failed/timed out — vectors stale until backfill");
              recordSystemEvent({
                userId: run.userId, source: "thread_tracker", severity: "warn",
                campaignId: run.campaignId, sessionId: run.sessionId,
                message: `thread-tracker re-embed failed or timed out for ${written.embedTargets.length} rewritten thread entr${written.embedTargets.length === 1 ? "y" : "ies"} — vectors stale until backfill`,
                details: { runId: run.id, count: written.embedTargets.length, entryIds: written.embedTargets.map((e) => e.id), error: err instanceof Error ? err.message : String(err) },
              });
            });
        }
        this.logger.info({ runId: run.id, changed: changedIds.size, active: written.active, pass: passIndex + 1, passes: passes.length }, "thread tracker pass committed");
      }
    } catch (error) {
      const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
      if (aborted) this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
      else this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "thread tracking failed", null);
      if (committed.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "thread_tracker", severity: "info", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
          message: `thread tracker ${aborted ? "was canceled" : "failed"} after ${committed.length} of ${passCount} passes had committed; their ledger writes stand, and the next tracker run continues after them`,
          details: { runId: run.id, passes: committed },
        });
      }
    }
  }

  /** An intermediate pass's progress marker, written in the pass's
   *  ledger transaction. A row that is no longer running (the owner canceled
   *  it) aborts the transaction, so the pass's writes roll back with it. */
  private recordPassProgress(run: { id: string; userId: string }, original: TrackerRunDetails, coverage: Record<string, unknown>): void {
    const row = this.runs.findById(run.userId, run.id);
    if (!row || row.status !== "running") throw new DOMException("thread tracker canceled between passes", "AbortError");
    this.runs.updateRun(run.id, { detailsJson: JSON.stringify({ ...original, ...coverage }), updatedAt: new Date().toISOString() });
  }

  private parsePriorThreads(commentJson: string | null): ThreadRecord[] {
    return parsePriorThreadRecords(commentJson);
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
  private commit(userId: string, campaignId: string, threads: ThreadRecord[], prior: ThreadRecord[], indexEntry: any, currentDate: string, turnNumber: number, changedIds: Set<string>, assertSource?: () => void, ledgerVersions = new Map<string, string>(), onCommitted?: (stats: { active: number; grace: number; graduated: number }) => void) {
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
      assertSource?.();
      // Version check: every ledger entry this run rewrites — the
      // index and each changed/graduating thread entry — must still be the
      // version the run read; an owner edit in between holds the whole rewrite.
      const rewritten = [indexEntry?.id, ...[...trackerThreads, ...graduating].filter((t) => changedIds.has(t.id) || graduating.includes(t)).map((t) => priorById.get(t.id)?.entryId)].filter((id): id is string => typeof id === "string");
      const changedUnderUs = rewritten.filter((id) => {
        const expected = ledgerVersions.get(id);
        if (expected === undefined) return false; // not read this run (e.g. created since) — the write is additive, not a clobber
        const live = this.lorebook.findById(userId, id);
        return !live || canonSourceVersion(live) !== expected;
      });
      if (changedUnderUs.length > 0) throw new TrackerLedgerChangedError(changedUnderUs);
      // Pending + grace-resolved -> `threads` entries (all sticky 0 since
      // 2026-05-26 — keyword/semantic/researcher activation carries them).
      for (const t of trackerThreads) {
        const priorEntryId = priorById.get(t.id)?.entryId;
        // Delta skip: an unchanged thread with a live entry needs no rewrite and
        // no re-embed — its content is byte-identical. This is what makes runs
        // O(changed) in writes, not O(campaign) (2026-07-13 redesign).
        if (!changedIds.has(t.id) && priorEntryId && this.lorebook.findById(userId, priorEntryId)) {
          t.entryId = priorEntryId;
          continue;
        }
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
      // asOfTurn/asOfDate/rebuiltAt = the MACHINE-READABLE freshness stamp; the
      // context engine's staleness hedge reads asOfTurn in preference to
      // regexing the prose header, which manual curation could silently break.
      const indexComment = JSON.stringify({ asOfTurn: turnNumber, asOfDate: currentDate || null, rebuiltAt: now, threads: trackerThreads });
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
      // Synchronous, same connection: the caller stamps the run's terminal
      // state here so ledger and status commit together.
      onCommitted?.({ active: pending.length, grace: grace.length, graduated: graduating.length });
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
    // like "The" or "Vale's" that keyword-activated the full thread entry on
    // virtually every turn, defeating the whole-phrase intent above.)
    return [...keys].filter(Boolean);
  }

  private renderThreadEntry(t: ThreadRecord): string { return renderThreadEntryText(t); }

  private renderIndex(threads: ThreadRecord[], currentDate: string, turnNumber: number): string { return renderIndexText(threads, currentDate, turnNumber); }

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

}


/** The per-thread lorebook entry text. Module-level and exported (2026-09-25) so
 *  the compaction tool renders byte-identically to the worker. */
export function renderThreadEntryText(t: ThreadRecord): string {
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

/** The constant Thread Index text: one bounded line per pending thread. The
 *  pending-dates tail is cut to THREAD_FIELD_CAPS.indexPendingDates here because
 *  the index rides EVERY turn as a constant (one campaign's reached 36k chars /
 *  10.3k tokens carrying each thread's full pending-dates field). */
export function renderIndexText(threads: ThreadRecord[], currentDate: string, turnNumber: number): string {
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
    const dates = t.pendingDates ? cutAtCap(t.pendingDates, THREAD_FIELD_CAPS.indexPendingDates) : "";
    lines.push(`[${t.id}] ${t.title} — ${t.headline} — ${t.status}${dates ? ` — ${dates}` : ""}`);
  }
  if (closed.length > 0) {
    lines.push(``, `Recently closed:`);
    for (const t of closed) lines.push(`[${t.id}] ${t.title} — ${t.status}`);
  }
  return lines.join("\n");
}
