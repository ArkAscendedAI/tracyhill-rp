import { pipelineInputsForRun } from "./settledSourceGuard";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { and, asc, eq, sql } from "drizzle-orm";
import { createDatabaseClient, lorebookEntries, migrateDatabase, type DatabaseClient } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { resolveCampaignEmbedModel } from "../../../api/src/domain/context/embedModelResolver";
import { isProvisionalMarker, parseOffscreenMarker } from "../../../api/src/domain/world/offscreen";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, withTimeout, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { resolveWorkerModel } from "./workerModel";
import { canonSourceVersion } from "./canonSourceVersion";
import { sessionTurnNumber, workerTurnNumber } from "./turnOrdinal";
import { completeRun } from "./runCompletion";
import { normalizeKeyList, parseStoredKeys } from "../../../api/src/domain/context/lorebookKeys";
import { KeyCapNotes } from "./keyCapNotes";
import { normalizeKnownBy } from "../../../api/src/domain/context/lorebookKnownBy";
import { NEVER_DELIVERED_IDLE_MS, deliveryEvidence, idleMs, otherSessionsLabel } from "./deliveryEvidence";

const MAX_ARCHIVAL_BATCH = 20;
const ARCHIVAL_POOL_LIMIT = 500;
const MIN_TURNS_INACTIVE = 500;
// Persistent world-building tags — never archived. "threads" is included: a pending
// thread that hasn't surfaced in many turns is still pending and must stay retrievable.
// (The thread tracker re-tags genuinely concluded threads off "threads" itself.)
export const ARCHIVAL_PROTECTED_TAGS: ReadonlySet<string> = new Set(["characters", "locations", "factions", "lore", "rules", "capabilities", "traits", "relationships", "threads"]);
const MIN_AGE_MS = 72 * 60 * 60 * 1000; // entries must exist 72h before archival eligibility

const ARCHIVAL_SYSTEM = `You are a lorebook archivist for an ongoing roleplay campaign. You will receive a batch of lorebook entries that have been inactive for many turns and are candidates for archival.

Your job is to create a single COMPRESSED TRIGGER entry for each group of related entries. The trigger is a retrieval index — it must contain enough detail that keyword search, semantic search, and an LLM researcher can find it when relevant, but it is NOT meant to be used as narrative context directly.

For each entry or natural group of closely related entries, produce a compressed trigger with:
- name: A descriptive title (e.g. "Aldric's first day — saves Bram from vampire attack")
- tag: "archived"
- synopsis: A 1-3 sentence summary capturing WHO, WHAT, WHERE, WHEN and distinctive details. Include unique keywords and character names for retrieval.
- keys: Union of all trigger keywords from the source entries, plus any additional distinctive terms from the content
- known_by: Union of known_by from all source entries (null if any source is global)

Output ONLY a JSON array of archival operations:
[
  {
    "op": "ARCHIVE",
    "source_ids": ["id1", "id2"],
    "name": "Descriptive trigger title",
    "synopsis": "1-3 sentence retrieval-grade summary with distinctive details...",
    "keys": ["key1", "key2", "key3"],
    "known_by": ["Character1"] or null
  }
]

Rules:
- NEVER discard information that would make the cold entries unfindable
- Include character names, location names, and distinctive nouns in keys
- The synopsis should contain enough unique detail that semantic search can match it to relevant queries
- Group entries ONLY if they describe the same event or scene — don't over-group
- If an entry should NOT be archived (still seems important), use: {"op": "SKIP", "entry_id": "...", "reason": "..."}`;

interface ArchivalOp {
  op: "ARCHIVE" | "SKIP";
  source_ids?: string[];
  entry_id?: string;
  name?: string;
  synopsis?: string;
  keys?: string[];
  known_by?: string[] | null;
  reason?: string;
}

/** Archival candidate filter (exported for the regression test). Provisional
 *  offscreen events are the ACTIVE living-world ledger — `offscreen.ts` defines
 *  it as enabled + provisional — and they are delivered deterministically via
 *  `<offscreen_memory>`, never through activation, so they look permanently
 *  idle to the staleness gates below. Archiving one disables it out of the
 *  ledger the next world tick reads (re-simulating what it should advance) and
 *  launders unconfirmed hidden canon into an ordinary `archived` trigger with no
 *  marker. Same predicate as the consolidation worker; the marker parser in
 *  `offscreen.ts` is the one reader. */
export function isArchivalCandidate(entry: { compressedRefIds: string | null; comment: string | null }): boolean {
  if (entry.compressedRefIds) return false; // already a compressed trigger
  if (isProvisionalMarker(parseOffscreenMarker(entry.comment))) return false;
  return true;
}

/** The rows archival may consider, least recently reviewed first. The exclusions
 *  run in SQL BEFORE the limit: the pool used to be
 *  the 500 least recently reviewed enabled rows of any tag, filtered afterwards,
 *  so protected tags, compressed triggers and the provisional offscreen ledger
 *  took slots and a stale `events` row outside that window was invisible. The
 *  provisional clause mirrors `isProvisionalMarker(parseOffscreenMarker(...))`:
 *  both flags must be a JSON `true` (json_type 'true'; `= 1` also matched a JSON
 *  1). CASE keeps the JSON functions away from
 *  free-text comments. `isArchivalCandidate` still runs on the result as the
 *  exact predicate. Exported for tests. */
export function listArchivalPool(db: DatabaseClient["db"], userId: string, campaignId: string, limit = ARCHIVAL_POOL_LIMIT) {
  const comment = lorebookEntries.comment;
  return db.select().from(lorebookEntries).where(and(
    eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId), eq(lorebookEntries.sealed, 0),
    eq(lorebookEntries.isEnabled, 1), eq(lorebookEntries.isConstant, 0),
    sql`coalesce(${lorebookEntries.compressedRefIds}, '') = ''`,
    sql`coalesce(${lorebookEntries.tag}, '') NOT IN (${sql.join([...ARCHIVAL_PROTECTED_TAGS].map((tag) => sql`${tag}`), sql`, `)})`,
    sql`(CASE WHEN json_valid(${comment}) THEN coalesce(json_type(${comment}, '$.offscreen') = 'true' AND json_type(${comment}, '$.provisional') = 'true', 0) ELSE 0 END) = 0`,
  )).orderBy(asc(lorebookEntries.lastReviewedAt), asc(lorebookEntries.id)).limit(limit).all();
}

export class LorebookArchivalWorker {
  private readonly logger = createLogger("lorebook-archival-worker");
  private readonly lorebook;
  private readonly runs;
  private readonly messages;
  private readonly sessions;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly embedding;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly db: DatabaseClient["db"];

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.db = db;
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.runs = new PipelineRunRepository(db);
    this.messages = new MessageRepository(db);
    this.sessions = new SessionRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    const providers = buildEmbeddingProviders(this.runtimeDefaults);
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    // Scoped revision context: restored after the run settles so a
    // shared repository instance never carries this run's id onto later writes.
    return this.lorebook.withRevisionContext({ source: "archival", pipelineRunId: run.id }, () => this.executeInContext(run, signal));
  }

  private async executeInContext(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const now = new Date().toISOString();
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { archivalModel?: string; embeddingModel?: string; workerEffort?: string; openaiFastMode?: boolean } : {};
      // The queue stamps the SESSION dial; the fallback is the same
      // newest-session rule the API uses (embedModelResolver), never a fossil.
      const embedModelId = details.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);

      // The least recently reviewed rows archival may touch: protected
      // tags, compressed triggers and the provisional ledger are excluded in
      // SQL before the limit; isArchivalCandidate re-checks exactly.
      const candidates = listArchivalPool(this.db, run.userId, run.campaignId).filter(isArchivalCandidate);

      const activationState = this.lorebook.getActivationState(run.sessionId ?? "");
      const activationMap = new Map(activationState.map(s => [s.entryId, s.lastActivatedTurn]));
      // currentTurn = the engine's turn as of the settling message, the
      // scale `lastActivatedTurn` is stamped on. It used to be half the settled
      // transcript's row count, which falls behind the engine's by every
      // unreceipted row (image rows, stopped replies, edited pairs), and before
      // that lorebook.countForCampaign(), the entry count. Counting reads no
      // transcript text, so archival captures no rows into its input manifest.
      let currentTurn = sessionTurnNumber(0);
      if (run.sessionId) {
        try { currentTurn = workerTurnNumber(this.messages, run.userId, run.sessionId, inputs.source); }
        catch (err) {
          // A failed count collapses currentTurn to 1, which disables the
          // turn-based staleness gate for this run; say so.
          recordSystemEvent({
            userId: run.userId, source: "lorebook_archival", severity: "warn",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: "lorebook archival could not count the session's messages — turn-based staleness gate disabled for this run",
            details: { runId: run.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      // Delivery in any session of the campaign counts; turns compare
      // only within this session, which numbers its own.
      const campaignEvidence = this.lorebook.findCampaignActivationEvidence(run.userId, run.campaignId, candidates.map((e) => e.id));
      const delivery = new Map(candidates.map((e) => [e.id, deliveryEvidence(e.id, activationMap, campaignEvidence)]));
      // Select entries that haven't been activated in a long time AND have existed long enough
      const selectNow = Date.now();
      const stale = candidates.filter(e => {
        const ageMs = selectNow - new Date(e.createdAt).getTime();
        if (ageMs < MIN_AGE_MS) return false;
        const evidence = delivery.get(e.id)!;
        if (evidence.kind === "this-session") return (currentTurn - evidence.turn) >= MIN_TURNS_INACTIVE;
        // Activation state is inclusion-scoped (2026-09-02). A row no session
        // ever delivered must also sit untouched for 7 days, so a fresh or
        // freshly edited row is not instantly eligible.
        const idle = idleMs(e, selectNow) >= NEVER_DELIVERED_IDLE_MS;
        if (evidence.kind === "never") return idle;
        // Delivered only in other sessions: its last delivery is at least
        // this whole session ago, so it is inactive for MIN_TURNS_INACTIVE only
        // once this session has run that long without it. It used to pass on
        // the 7-day idle guard alone, so a new session could archive the
        // events the previous one delivered every turn.
        return idle && currentTurn >= MIN_TURNS_INACTIVE;
      });

      // Persistent world-building tags are never archived (the pool query
      // already leaves them out; this is the in-code guard).
      const archivable = stale.filter(e => !ARCHIVAL_PROTECTED_TAGS.has(e.tag ?? ""));

      if (archivable.length === 0) {
        completeRun(this.runs, run.id, now, "No entries eligible for archival", JSON.stringify({ candidates: 0, archived: 0 }));
        return;
      }

      const batch = archivable.slice(0, MAX_ARCHIVAL_BATCH);
      // Source versions as SELECTED: compared inside each ARCHIVE
      // op's transaction so an entry the owner edits during the model call is
      // never disabled under a synopsis authored against its pre-edit text.
      const batchVersions = new Map(batch.map((e) => [e.id, canonSourceVersion(e)]));

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // An unresolvable archivalModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "lorebook_archival", "lorebook archival", details.archivalModel, getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      const entriesText = batch.map(e => {
        const keys = (() => { try { return JSON.parse(e.keys); } catch { return []; } })();
        const evidence = delivery.get(e.id)!;
        const lastDelivered = evidence.kind === "this-session" ? `turn ${evidence.turn} (${currentTurn - evidence.turn} turns ago)`
          : evidence.kind === "other-session" ? otherSessionsLabel(evidence.sessions) : "never";
        return `[${e.id}] ${e.name} (${e.tag ?? "untagged"})\nKeys: ${keys.join(", ") || "none"}\nKnown by: ${e.knownBy ?? "global"}\nLast delivered into context: ${lastDelivered}\nContent: ${e.content}`;
      }).join("\n\n---\n\n");

      let responseText = "";
      this.runs.heartbeat(run.id);
      await withDeadline(WORKER_LLM_DEADLINE_MS, "archival model call", (dl) => withRetry(() => runtime.streamChat({
        modelId,
        systemPrompt: ARCHIVAL_SYSTEM,
        messages: [{ role: "user", content: `current_turn=${currentTurn}\n\n<entries_to_archive>\n${entriesText}\n</entries_to_archive>`, attachments: [] }],
        temperature: 0,
        thinkingMode: workerThinkingModeFor(modelId, workerEffort),
        thinkingBudget: null,
        effort: workerEffort,
        cacheTtl: "off",
        speed,
        requestId: `archival-${run.id}`,
        signal: dl,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: () => {},
      }), () => { responseText = ""; }, signal), signal);

      const parsedOps = this.parseOps(responseText);
      // No-silent-failures: a non-empty response with no JSON array in it is a
      // parse failure. A parsed empty array is the model's answer (it reviewed
      // the batch and archived nothing), as in the rolling diff; it used to be
      // flagged as a parse failure too.
      const parseFailed = parsedOps === null && responseText.trim().length > 0;
      if (parseFailed) {
        recordSystemEvent({
          userId: run.userId, source: "lorebook_archival", severity: "warn",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: "lorebook archival produced 0 ops from a non-empty model response — likely a parse failure",
          details: { responseLen: responseText.length, head: responseText.slice(0, 200) },
        });
      }
      const ops = parsedOps ?? [];
      const keyCaps = new KeyCapNotes();
      const { archived, skipped, held, createdIds } = this.applyOps(run.userId, run.campaignId, ops, batch, batchVersions, assertSource, keyCaps);
      // The batch counts as reviewed after a clean parse: stamped rows move
      // to the back of the pool, so the next run sees the candidates behind
      // them. Only the rolling diff's stale sweep stamped this column, so a
      // batch the model declined came back first on every run. Rows edited
      // during the run were not reviewed against their new text and stay put.
      if (parsedOps !== null) {
        const heldIds = new Set(held);
        this.lorebook.touchLastReviewedAt(run.userId, batch.map((e) => e.id).filter((id) => !heldIds.has(id)));
      }
      if (held.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "lorebook_archival", severity: "info",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `lorebook archival held ${held.length} entr${held.length === 1 ? "y" : "ies"} edited during the run — left active; a later run re-evaluates`,
          details: { runId: run.id, entryIds: held },
        });
      }

      // The run completes as soon as its writes have landed, before the
      // best-effort embed, as the rolling diff and the tracker do: the
      // embed can take minutes, and a cancel landing in that window used to
      // leave the triggers under a canceled row that still got approvedAt.
      // A cancel that lands anyway leaves the row canceled, unstamped, and says
      // what stands.
      const doneAt = new Date().toISOString();
      const completed = completeRun(this.runs, run.id, doneAt,
        `Archival: ${archived} compressed, ${skipped} skipped${held.length ? `, ${held.length} held (edited during the run)` : ""} (${batch.length} candidates)`,
        JSON.stringify({ candidates: archivable.length, batched: batch.length, archived, skipped, held, ...(keyCaps.list().length > 0 ? { keyCaps: keyCaps.list() } : {}), modelId }),
      );
      if (!completed && archived > 0) {
        recordSystemEvent({
          userId: run.userId, source: "lorebook_archival", severity: "info",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `lorebook archival was canceled after it wrote ${archived} compressed trigger${archived === 1 ? "" : "s"}; they stand (each disabled its sources in one transaction) and the run stays canceled`,
          details: { runId: run.id, archived },
        });
      }

      // Embed exactly the triggers this run created: the ids come back
      // from applyOps. The step used to re-query the campaign's most recently
      // updated compressed triggers, so a trigger another writer touched after
      // this run's took its slot and the new one got no vector.
      if (createdIds.length > 0) {
        const compressedEntries = this.lorebook.findByIds(run.userId, createdIds, run.campaignId);
        if (compressedEntries.length > 0) {
          await withTimeout(this.embedding.indexEntries(
            compressedEntries.map(e => ({ id: e.id, userId: run.userId, content: e.content })),
            embedModelId,
          ), WORKER_LLM_DEADLINE_MS, "post-archival embed").catch((err) => {
            // indexEntries records its own events for provider errors; the
            // withTimeout rejection (a hung embed) is a different path and must
            // surface too — a trigger with no vector is semantically unfindable.
            this.logger.warn({ runId: run.id, err }, "post-archival embed failed/timed out — vectors stale until backfill");
            recordSystemEvent({
              userId: run.userId, source: "lorebook_archival", severity: "warn",
              campaignId: run.campaignId, sessionId: run.sessionId,
              message: `post-archival embed failed or timed out for ${compressedEntries.length} compressed trigger(s) — vectors stale until backfill`,
              details: { runId: run.id, count: compressedEntries.length, error: err instanceof Error ? err.message : String(err) },
            });
          });
        }
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "archival failed", null);
    }
  }

  /** null when no JSON array could be parsed (a parse failure); [] when the
   *  model answered with an empty array. */
  private parseOps(text: string): ArchivalOp[] | null {
    const parsed = parseFirstJson<unknown>(text, "[");
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((op: any) => op && typeof op.op === "string");
  }

  private applyOps(userId: string, campaignId: string, ops: ArchivalOp[], batch: Array<{ id: string; keys: string }>, batchVersions: Map<string, string>, assertSource?: () => void, keyCaps = new KeyCapNotes()): { archived: number; skipped: number; held: string[]; createdIds: string[] } {
    const now = new Date().toISOString();
    const batchById = new Map(batch.map((e) => [e.id, e]));
    let archived = 0;
    let skipped = 0;
    const held: string[] = [];
    const createdIds: string[] = [];
    // Each source id is consumed by at most ONE trigger: overlapping
    // groups ([a,b] and [b,c]) used to give `b` two compressed triggers, so it
    // inflated twice whenever either fired.
    const consumed = new Set<string>();

    for (const op of ops) {
      if (op.op === "SKIP") { skipped++; continue; }
      if (op.op !== "ARCHIVE" || !op.source_ids?.length || !op.name || !op.synopsis) continue;

      // Validate all source IDs are in our batch and not yet consumed this run
      const validSources = [...new Set(op.source_ids)].filter(id => batchById.has(id) && !consumed.has(id));
      if (validSources.length === 0) continue;
      // Version check: a source edited since selection is not
      // archived under a synopsis that predates the edit — the whole op is held
      // (its synopsis was authored for that set of sources).
      const changed = validSources.filter((id) => {
        const live = this.lorebook.findById(userId, id);
        return !live || canonSourceVersion(live) !== batchVersions.get(id);
      });
      if (changed.length > 0) { held.push(...changed); continue; }

      // Create the compressed trigger entry
      const triggerId = createId();
      const triggerContent = op.synopsis;
      // "Keyword union" is a server guarantee, not a prompt promise:
      // the trigger is the ONLY retrieval handle the cold entries keep, so a
      // model that returns a partial key list (or none) must not make them
      // keyword-unfindable. Source keys first, then the model's additions.
      // Held to LOREBOOK_MAX_KEYS like every stored list. The cold rows
      // keep their own keys, and the engine's cold-keyword scan remaps them to
      // this trigger, so a key the cap leaves off still reaches them; the cap
      // is named in the run's details.
      const name = op.name;
      const triggerKeys = normalizeKeyList(unionKeys(validSources.map((id) => batchById.get(id)!.keys), op.keys ?? []));
      const synopsis = op.synopsis;
      // Bounded like an editor's list; empty is null (common knowledge).
      const scope = normalizeKnownBy(op.known_by).knownBy;
      const knownBy = scope ? JSON.stringify(scope) : null;

      // Trigger create + source disable are ONE transaction: a kill
      // between them left a trigger AND its full sources active (double
      // context) or, on the other ordering, sources dark with no trigger.
      // The version compare is repeated INSIDE the transaction so an edit
      // landing between the check above and the write is caught too.
      const wrote = this.lorebook.transact(() => {
        assertSource?.();
        for (const id of validSources) {
          const live = this.lorebook.findById(userId, id);
          if (!live || canonSourceVersion(live) !== batchVersions.get(id)) { held.push(id); return false; }
        }
        this.lorebook.create({
          id: triggerId,
          userId,
          campaignId,
          name,
          tag: "archived",
          content: triggerContent,
          comment: `compressed trigger for ${validSources.length} cold entries`,
          keys: JSON.stringify(triggerKeys.keys),
          keysSecondary: "[]",
          selectiveLogic: "and_any",
          scanDepth: 4,
          position: "before_main",
          insertionOrder: 100,
          probability: 100,
          isConstant: 0,
          isEnabled: 1,
          sticky: 0,
          cooldown: 0,
          delay: 0,
          excludeRecursion: 0,
          preventRecursion: 0,
          delayUntilRecursion: 0,
          tokensEstimate: estimateTokens(synopsis),
          knownBy,
          matchOptionsJson: null,
          legacySource: null,
          compressedRefIds: JSON.stringify(validSources),
          createdAt: now,
          updatedAt: now,
        });

        // Disable the source entries (move to cold storage) — embeddings are preserved
        this.lorebook.bulkSetEnabled(userId, validSources, false, campaignId);
        return true;
      });
      if (!wrote) continue;
      keyCaps.noteList(name, triggerKeys);
      for (const id of validSources) consumed.add(id);
      createdIds.push(triggerId);
      archived++;
    }

    return { archived, skipped, held, createdIds };
  }
}

/** Case-insensitive union of the sources' stored key lists plus the model's
 *  proposed keys, source keys first, original casing of the first sighting
 *  kept, through the shared key rule without the list cap (the caller
 *  caps the stored list and notes it). Exported for the regression test. */
export function unionKeys(sourceKeyJson: string[], proposed: unknown[]): string[] {
  return normalizeKeyList([...sourceKeyJson.flatMap((json) => parseStoredKeys(json)), ...(Array.isArray(proposed) ? proposed : [])], { max: Number.MAX_SAFE_INTEGER }).keys;
}
