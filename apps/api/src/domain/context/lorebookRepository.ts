import { and, asc, desc, eq, getTableColumns, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { LOREBOOK_CHARS_PER_TOKEN, LOREBOOK_COMMENT_MAX_CHARS, LOREBOOK_MAX_KEYS, THREADS_TAG, THREAD_INDEX_ENTRY_NAME, estimateLorebookTokens } from "@tracyhill-rp/contracts";
import { lorebookEntries, lorebookActivationState, sessions, type DatabaseClient } from "@tracyhill-rp/db";

import { recordSystemEvent, type SystemEventInput } from "../system/systemEvents";
import { isArchiveTrigger, parseCompressedRefIds, type ReparentArchiveTriggerResult } from "./archiveTriggers";
import { MAX_EMBED_INPUT_CHARS } from "./embeddingService";
import type { LorebookRevisionRepository, RevisionWriteContext } from "./lorebookRevisionRepository";

// Entry-size watchdog thresholds (estimator tokens, chars/3.5 — the same
// estimator the budget pruner spends). The rolling diff's obligated character
// UPDATEs grew two cores monotonically to ~20k/~11k tokens over days of heavy
// play with no signal until the embedding layer started hard-failing on them
// (2026-08-27). An entry crossing these lines must surface AT THE WRITE.
//
// Tag-aware calibration (2026-08-28): the 4,500 guidance line exists for
// GUARANTEED-DELIVERY entries — character cores (the scene-present override
// force-includes them) and constants — whose size taxes every single turn.
// Score-competing entries are exactly where the size governor MOVES history
// to; a flat 4,500 flagged the governor's own freshly-created Records
// satellite as a problem (the 2026-08-28 false positive). Those warn only when
// approaching the embed cap. Every first crossing must warn, including gradual
// growth. A previous-value hysteresis gate lost these crossings entirely;
// repeated growth above the same line remains quiet.
// 3,500 since 2026-09-25 (was 4,500): matched to the rolling diff's ~12,000-char
// SIZE GOVERNOR (3,430 estimator tokens), which the code now also enforces on
// the diff's UPDATE path. Six character cores of one campaign sat between
// the two lines for weeks with zero warnings.
const ENTRY_SIZE_WARN_TOKENS_GUARANTEED = 3500;
const ENTRY_SIZE_WARN_TOKENS_SCORED = 7000;
// The cap line is the embedder's own number: an entry
// whose content is longer than MAX_EMBED_INPUT_CHARS characters embeds truncated
// (embeddingService.ts). It used to be 8,192 estimator tokens (~28,672 chars),
// so an entry between the two numbers embedded truncated with no crossing event.
const ENTRY_SIZE_CAP_CHARS = MAX_EMBED_INPUT_CHARS;
// The shared lorebook estimate: the same function tokens_estimate is written with.
const estimateTokens = estimateLorebookTokens;

/** Campaign-wide delivery evidence for one entry; see findCampaignActivationEvidence. */
export interface CampaignActivationEvidence {
  /** Sessions of the campaign (recycle bin included) whose activation state carries a delivery turn for the entry. */
  sessionCount: number;
  /** Of those, the session with the newest activity (last message, else last update). */
  latestSessionId: string;
  /** The turn, in that session's own numbering, the entry was last delivered. Turn numbers of different sessions are not comparable. */
  latestTurn: number;
  /** That session's last activity timestamp. */
  latestSessionActiveAt: string;
}

export interface LorebookListOptions {
  isEnabled?: boolean;
  isConstant?: boolean;
  sealed?: boolean;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
  search?: string;
  tag?: string;
  offscreen?: boolean;
  provisional?: boolean;
}

/** Backslash-escape `\`, `%` and `_` for a LIKE … ESCAPE '\' pattern. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Pure threshold decision on content LENGTHS in characters, exported for direct
 * unit testing. "cap": the write takes the content past MAX_EMBED_INPUT_CHARS,
 * the length the embedder truncates at. "warn": it crosses the delivery-size
 * guidance, measured in estimator tokens (chars/3.5).
 */
export function classifyEntrySizeCrossing(
  oldChars: number,
  newChars: number,
  guaranteedDelivery: boolean,
): "cap" | "warn" | null {
  if (oldChars <= ENTRY_SIZE_CAP_CHARS && newChars > ENTRY_SIZE_CAP_CHARS) return "cap";
  const oldTokens = Math.ceil(oldChars / LOREBOOK_CHARS_PER_TOKEN);
  const newTokens = Math.ceil(newChars / LOREBOOK_CHARS_PER_TOKEN);
  const warnAt = guaranteedDelivery ? ENTRY_SIZE_WARN_TOKENS_GUARANTEED : ENTRY_SIZE_WARN_TOKENS_SCORED;
  if (oldTokens < warnAt && newTokens >= warnAt) return "warn";
  return null;
}

export class LorebookRepository {
  // Revision capture context applied to the NEXT destructive mutation(s). The
  // manual path (LorebookService) leaves the default ("manual"); each worker sets
  // its kind + run.id via setRevisionContext() before its write-batch. Capture is
  // a no-op when no revisions repo is injected (back-compat construction).
  private revisionContext: RevisionWriteContext = { source: "manual", pipelineRunId: null };

  // Events raised by writes that run INSIDE transact() are held here and
  // recorded after the commit. The dedicated worker
  // process records system_events on index.ts's connection while every worker
  // holds its own; since every transaction opens BEGIN IMMEDIATE, an
  // insert on the recorder's connection from inside a worker transaction waits
  // out busy_timeout (5 s) against the lock this very transaction holds, then
  // loses the row. Deferring keeps the warning AND the 5 s. A rolled-back
  // transaction discards its held events: the crossing never happened.
  private transactDepth = 0;
  private deferredEvents: SystemEventInput[] = [];

  constructor(
    private readonly db: DatabaseClient["db"],
    private readonly revisions?: LorebookRevisionRepository | null,
  ) {}

  /** Set the source/run context for subsequent destructive mutations.
   *  Prefer withRevisionContext() — this form never restores the previous
   *  context, so a worker that shares the repository instance leaks its run id
   *  onto the next caller's writes. */
  setRevisionContext(ctx: RevisionWriteContext) {
    this.revisionContext = { source: ctx.source, pipelineRunId: ctx.pipelineRunId ?? null };
  }

  /**
   * Run `fn` with the given source/run context and RESTORE the previous context
   * afterwards — including when `fn` throws, and, when `fn` returns a promise,
   * only after that promise settles (async-safe). This is the scoped form every
   * shared-instance writer should use; setRevisionContext() stays for the
   * call sites not yet migrated.
   */
  withRevisionContext<T>(ctx: RevisionWriteContext, fn: () => T): T {
    const previous = this.revisionContext;
    this.setRevisionContext(ctx);
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.revisionContext = previous;
      throw err;
    }
    if (isPromiseLike(result)) {
      // Restore after settle, but hand back the ORIGINAL promise's outcome.
      return (result as PromiseLike<unknown>).then(
        (value) => { this.revisionContext = previous; return value; },
        (err) => { this.revisionContext = previous; throw err; },
      ) as T;
    }
    this.revisionContext = previous;
    return result;
  }

  /** Capture the current row of an entry (pre-write) under the active context. */
  private captureRevision(userId: string, entryId: string) {
    this.revisions?.captureCurrent(userId, entryId, this.revisionContext);
  }

  /**
   * The ONE predicate shared by listForCampaign and countForCampaign so the
   * list's `total` is the FILTERED count (Android displays it and
   * uses it as its paging break; the unfiltered campaign count was wrong under
   * any tag/search/enabled/offscreen/provisional facet).
   */
  private campaignConditions(userId: string, campaignId: string, opts?: LorebookListOptions) {
    const conditions = [
      eq(lorebookEntries.userId, userId),
      eq(lorebookEntries.campaignId, campaignId),
      eq(lorebookEntries.sealed, opts?.sealed ? 1 : 0),
    ];
    if (opts?.isEnabled !== undefined) conditions.push(eq(lorebookEntries.isEnabled, opts.isEnabled ? 1 : 0));
    if (opts?.isConstant !== undefined) conditions.push(eq(lorebookEntries.isConstant, opts.isConstant ? 1 : 0));
    if (opts?.tag) conditions.push(eq(lorebookEntries.tag, opts.tag));
    // Living World Phase 2 — offscreen/provisional facet. Markers live as JSON in
    // the entry comment; json_valid guards free-text comments (json_extract on
    // malformed JSON raises, it does not return NULL). Each flag counts only as a
    // JSON `true` (json_type 'true'), and Provisional needs the offscreen flag
    // too: the reading of offscreen.ts and both clients (`= 1` used to match a
    // JSON 1 as well).
    if (opts?.offscreen) conditions.push(sql`json_valid(${lorebookEntries.comment}) AND json_type(${lorebookEntries.comment}, '$.offscreen') = 'true'`);
    if (opts?.provisional) conditions.push(sql`json_valid(${lorebookEntries.comment}) AND json_type(${lorebookEntries.comment}, '$.offscreen') = 'true' AND json_type(${lorebookEntries.comment}, '$.provisional') = 'true'`);
    if (opts?.search) {
      // Escape the LIKE metacharacters so a search for "100%" or "_" matches
      // literally instead of everything. Parameterized either way.
      const pattern = `%${escapeLikePattern(opts.search)}%`;
      const likeEscaped = (col: SQLiteColumn) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
      conditions.push(or(likeEscaped(lorebookEntries.name), likeEscaped(lorebookEntries.content), likeEscaped(lorebookEntries.keys))!);
    }
    return conditions;
  }

  listForCampaign(userId: string, campaignId: string, opts?: LorebookListOptions) {
    const sortCol = this.resolveSortColumn(opts?.sort);
    const orderFn = opts?.order === "asc" ? asc : desc;
    // `id` breaks ties: tag, insertion order, scan depth and the
    // one timestamp a batch write stamps are full of ties, and without a total
    // order the offset pages of the web (1,000) and Android (500) could skip or
    // repeat rows whenever the tied rows' physical order moved between two page
    // requests (a revert that recreates a deleted row, for one).
    return this.db.select().from(lorebookEntries)
      .where(and(...this.campaignConditions(userId, campaignId, opts)))
      .orderBy(orderFn(sortCol), asc(lorebookEntries.id))
      .limit(opts?.limit ?? 200)
      .offset(opts?.offset ?? 0)
      .all();
  }

  /**
   * listForCampaign without the entry text (`view=summary`): same filters,
   * order and paging, every column but `content`, plus the content's length.
   * `comment` is carried up to LOREBOOK_COMMENT_MAX_CHARS characters (notes and
   * offscreen markers, which a list reads); a longer one (the tracker's ledger)
   * is left out and `commentChars` gives its length. Nothing large leaves SQLite.
   */
  listSummaryForCampaign(userId: string, campaignId: string, opts?: LorebookListOptions) {
    const sortCol = this.resolveSortColumn(opts?.sort);
    const orderFn = opts?.order === "asc" ? asc : desc;
    const { content: _content, comment: _comment, ...columns } = getTableColumns(lorebookEntries);
    return this.db.select({
      ...columns,
      contentChars: sql<number>`length(${lorebookEntries.content})`,
      commentChars: sql<number>`coalesce(length(${lorebookEntries.comment}), 0)`,
      comment: sql<string | null>`CASE WHEN length(${lorebookEntries.comment}) <= ${LOREBOOK_COMMENT_MAX_CHARS} THEN ${lorebookEntries.comment} ELSE NULL END`,
    }).from(lorebookEntries)
      .where(and(...this.campaignConditions(userId, campaignId, opts)))
      .orderBy(orderFn(sortCol), asc(lorebookEntries.id))
      .limit(opts?.limit ?? 200)
      .offset(opts?.offset ?? 0)
      .all();
  }

  /** Count with the SAME filters as listForCampaign (sort/limit/offset ignored). */
  countForCampaign(userId: string, campaignId: string, opts?: LorebookListOptions) {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(lorebookEntries)
      .where(and(...this.campaignConditions(userId, campaignId, opts)))
      .get();
    return row?.count ?? 0;
  }

  countPerCampaign(userId: string): Map<string, number> {
    const rows = this.db.select({ campaignId: lorebookEntries.campaignId, count: sql<number>`count(*)` })
      .from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.sealed, 0)))
      .groupBy(lorebookEntries.campaignId)
      .all();
    const map = new Map<string, number>();
    for (const r of rows) if (r.campaignId) map.set(r.campaignId, r.count);
    return map;
  }

  listEnabledForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId), eq(lorebookEntries.isEnabled, 1), eq(lorebookEntries.sealed, 0)))
      .orderBy(asc(lorebookEntries.insertionOrder))
      .all();
  }

  // ALL entries for a campaign — enabled AND disabled (cold-storage). The
  // existing enabled-only rebuild leaves cold/disabled entries with stale (or
  // missing) vectors under a new embedding model; the cold→compressed remap
  // then can't fire. Used by the cold-inclusive re-embed tooling.
  listAllForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId), eq(lorebookEntries.sealed, 0)))
      .orderBy(asc(lorebookEntries.insertionOrder))
      .all();
  }

  listGlobalsForUser(userId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), isNull(lorebookEntries.campaignId), eq(lorebookEntries.isEnabled, 1), eq(lorebookEntries.sealed, 0)))
      .orderBy(asc(lorebookEntries.insertionOrder))
      .all();
  }

  findById(userId: string, entryId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId), eq(lorebookEntries.sealed, 0)))
      .get();
  }

  /**
   * The campaign's Thread Index: the CONSTANT, unsealed
   * `threads` entry named THREAD_INDEX_ENTRY_NAME, found by what it is. The drive
   * worker and the world tick used to take the five most recently updated
   * `threads` rows and pick the index out of them, but the tracker commits the
   * index and every thread it rewrote with one timestamp, so after a run that
   * changed five or more threads SQLite's tie order decided whether the index was
   * in the slice (measured 2026-09-28: outside it on one campaign; 69 of 122 tracker
   * runs in 30 days changed five or more threads). Enabled or not: the ledger is
   * the tracker's state either way, as the tracker's own lookup has it. Newest
   * first should a campaign ever carry two.
   */
  findThreadIndex(userId: string, campaignId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(
        eq(lorebookEntries.userId, userId),
        eq(lorebookEntries.campaignId, campaignId),
        eq(lorebookEntries.sealed, 0),
        eq(lorebookEntries.isConstant, 1),
        eq(lorebookEntries.tag, THREADS_TAG),
        eq(lorebookEntries.name, THREAD_INDEX_ENTRY_NAME),
      ))
      .orderBy(desc(lorebookEntries.updatedAt), asc(lorebookEntries.id))
      .get();
  }

  findIncludingSealed(userId: string, entryId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId)))
      .get();
  }

  listSealedForCampaign(userId: string, campaignId: string) {
    return this.listForCampaign(userId, campaignId, { sealed: true, limit: 1000, sort: "updated_at", order: "desc" });
  }

  /** Owned, unsealed rows for a list of ids. With `campaignId` the rows must
   *  also belong to THAT campaign — the bulk verbs pass the route's campaign so
   *  a stale selection from another campaign can never be acted on. */
  findByIds(userId: string, entryIds: string[], campaignId?: string) {
    if (entryIds.length === 0) return [];
    const results: (typeof lorebookEntries.$inferSelect)[] = [];
    for (let i = 0; i < entryIds.length; i += 500) {
      const batch = entryIds.slice(i, i + 500);
      const conditions = [eq(lorebookEntries.userId, userId), eq(lorebookEntries.sealed, 0), sql`${lorebookEntries.id} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`];
      if (campaignId !== undefined) conditions.push(eq(lorebookEntries.campaignId, campaignId));
      const rows = this.db.select().from(lorebookEntries).where(and(...conditions)).all();
      results.push(...rows);
    }
    return results;
  }

  // Warn ON THE CROSSING of a size threshold (clearly-below → at-or-above; see
  // classifyEntrySizeCrossing), not on every write while above it — the embed
  // layer separately warns per index attempt on over-cap entries, so the
  // sustained state stays visible without this chokepoint spamming a row per
  // rolling-diff run.
  private warnOnSizeCrossing(
    userId: string,
    name: string,
    campaignId: string | null | undefined,
    oldContent: string | null,
    newContent: string,
    tag: string | null | undefined,
    isConstant: number | null | undefined,
  ) {
    const oldChars = oldContent ? oldContent.length : 0;
    const oldTokens = oldContent ? estimateTokens(oldContent) : 0;
    const newTokens = estimateTokens(newContent);
    const guaranteed = tag === "characters" || isConstant === 1;
    const crossing = classifyEntrySizeCrossing(oldChars, newContent.length, guaranteed);
    if (!crossing) return;
    const message = crossing === "cap"
      ? `entry "${name}" grew past the embedding cap (${newContent.length} characters > ${ENTRY_SIZE_CAP_CHARS}) — its vector will embed TRUNCATED until it is split into a core entry and satellite entries`
      : guaranteed
        ? `entry "${name}" crossed the delivery-size guidance (~${newTokens} tokens ≥ ${ENTRY_SIZE_WARN_TOKENS_GUARANTEED}) — this entry is guaranteed into context, so its size taxes every turn; split it into a core entry and satellite entries`
        : `entry "${name}" grew to ~${newTokens} tokens (≥ ${ENTRY_SIZE_WARN_TOKENS_SCORED}) — approaching the ${ENTRY_SIZE_CAP_CHARS}-character embedding cap; split it into a core entry and satellite entries before its vector embeds truncated`;
    this.emitEvent({
      userId,
      source: "lorebook_size",
      // Past the cap the vector embeds truncated (a degradation — alert);
      // approaching it or crossing the delivery guidance is advice (notice).
      severity: crossing === "cap" ? "warn" : "info",
      message,
      campaignId: campaignId ?? null,
      details: { source: this.revisionContext.source, oldTokens, newTokens, oldChars, chars: newContent.length, capChars: ENTRY_SIZE_CAP_CHARS, guaranteed },
    });
  }

  /** Record now, or hold until the enclosing transact() commits (see deferredEvents). */
  private emitEvent(event: SystemEventInput) {
    if (this.transactDepth > 0) { this.deferredEvents.push(event); return; }
    recordSystemEvent(event);
  }

  create(input: typeof lorebookEntries.$inferInsert) {
    if (typeof input.content === "string") {
      this.warnOnSizeCrossing(input.userId, input.name ?? input.id, input.campaignId, null, input.content, input.tag, input.isConstant ?? 0);
    }
    this.db.insert(lorebookEntries).values(input).run();
  }

  createMany(inputs: (typeof lorebookEntries.$inferInsert)[]) {
    if (inputs.length === 0) return;
    for (const input of inputs) {
      if (typeof input.content === "string") {
        this.warnOnSizeCrossing(input.userId, input.name ?? input.id, input.campaignId, null, input.content, input.tag, input.isConstant ?? 0);
      }
    }
    for (let i = 0; i < inputs.length; i += 500) {
      const batch = inputs.slice(i, i + 500);
      this.db.insert(lorebookEntries).values(batch).run();
    }
  }

  update(userId: string, entryId: string, input: Partial<typeof lorebookEntries.$inferInsert>) {
    if (typeof input.content === "string") {
      const old = this.findIncludingSealed(userId, entryId);
      if (old) {
        this.warnOnSizeCrossing(
          userId, old.name, old.campaignId, old.content, input.content,
          input.tag ?? old.tag, input.isConstant ?? old.isConstant,
        );
      }
    }
    // Snapshot + write in ONE transaction so a failed write (busy DB) can't
    // leave a phantom pre-write revision — and its prune of an older real
    // revision — behind. Same shape in every mutator below.
    this.db.transaction(() => {
      this.captureRevision(userId, entryId); // snapshot pre-write
      this.db.update(lorebookEntries).set(input)
        .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId))).run();
    });
  }

  /**
   * Restore a revision snapshot onto an entry WITHOUT auto-capturing again — the
   * revert flow snapshots the pre-revert state itself before calling this, so a
   * second capture here would duplicate it. The size watchdog runs as on any
   * other write: a revert to an older, larger text used to
   * cross the lines with no event.
   */
  restoreSnapshot(userId: string, entryId: string, input: Partial<typeof lorebookEntries.$inferInsert>) {
    if (typeof input.content === "string") {
      const old = this.findIncludingSealed(userId, entryId);
      if (old) {
        this.warnOnSizeCrossing(
          userId, input.name ?? old.name, old.campaignId, old.content, input.content,
          input.tag !== undefined ? input.tag : old.tag, input.isConstant ?? old.isConstant,
        );
      }
    }
    this.db.update(lorebookEntries).set(input)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId))).run();
  }

  remove(userId: string, entryId: string) {
    this.db.transaction(() => {
      this.captureRevision(userId, entryId); // snapshot pre-delete (revert recreates it)
      this.db.delete(lorebookEntries)
        .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId))).run();
    });
  }

  /** Delete owned rows by id; with `campaignId` the delete predicate is also
   *  campaign-scoped (the bulk route's campaign). */
  removeMany(userId: string, entryIds: string[], campaignId?: string) {
    if (entryIds.length === 0) return;
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        this.captureRevision(userId, id);
        const conditions = [eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id)];
        if (campaignId !== undefined) conditions.push(eq(lorebookEntries.campaignId, campaignId));
        tx.delete(lorebookEntries).where(and(...conditions)).run();
      }
    });
  }

  /**
   * Shared body of the id-list bulk mutators. Resolves the ids through
   * findByIds (owned, unsealed AND in the route's campaign — a sealed Dramatist
   * note's id is visible in the admin dramatist-log, and the raw-id form let
   * /bulk disable, retag or sticky it and copy its content into a `manual`
   * revision; a selection carried across a campaign switch used to be
   * applied to the OTHER campaign's rows), then captures + writes each
   * row inside one transaction.
   */
  private bulkUpdate(userId: string, entryIds: string[], patch: Partial<typeof lorebookEntries.$inferInsert>, campaignId?: string) {
    if (entryIds.length === 0) return;
    const owned = this.findByIds(userId, entryIds, campaignId).map((row) => row.id);
    if (owned.length === 0) return;
    this.db.transaction((tx) => {
      for (const id of owned) {
        this.captureRevision(userId, id);
        const conditions = [eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id), eq(lorebookEntries.sealed, 0)];
        if (campaignId !== undefined) conditions.push(eq(lorebookEntries.campaignId, campaignId));
        tx.update(lorebookEntries).set(patch).where(and(...conditions)).run();
      }
    });
  }

  // `campaignId`: the HTTP bulk route ALWAYS passes its route
  // campaign; a worker passes nothing only because its ids already come from
  // its own campaign-scoped query (lorebookArchivalWorker).
  bulkSetEnabled(userId: string, entryIds: string[], enabled: boolean, campaignId?: string) {
    this.bulkUpdate(userId, entryIds, { isEnabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() }, campaignId);
  }

  /** `null` clears the tag; an empty string is never stored. */
  bulkSetTag(userId: string, entryIds: string[], tag: string | null, campaignId?: string) {
    this.bulkUpdate(userId, entryIds, { tag: tag?.trim() || null, updatedAt: new Date().toISOString() }, campaignId);
  }

  /**
   * Append keys to each entry's key list, case-insensitively deduped against
   * the entry's existing keys (and within the added set). Entries that gain no
   * new key are untouched (no revision capture, no updatedAt bump). A list
   * never grows past LOREBOOK_MAX_KEYS — the contract cap the editor's
   * full-payload save is validated against; keys that did not fit
   * are returned per entry, in the order they were requested, so the caller
   * can report them.
   */
  bulkAppendKeys(userId: string, entryIds: string[], keysToAdd: string[], campaignId?: string): { truncated: { id: string; name: string; dropped: string[] }[] } {
    const truncated: { id: string; name: string; dropped: string[] }[] = [];
    if (entryIds.length === 0 || keysToAdd.length === 0) return { truncated };
    const rows = this.findByIds(userId, entryIds, campaignId);
    const now = new Date().toISOString();
    const changes: { id: string; keys: string }[] = [];
    for (const row of rows) {
      let existing: string[] = [];
      try {
        const parsed = JSON.parse(row.keys || "[]");
        if (Array.isArray(parsed)) existing = parsed.filter((k): k is string => typeof k === "string");
      } catch { /* treat malformed keys as empty */ }
      const seen = new Set(existing.map((k) => k.toLowerCase()));
      const merged = [...existing];
      const dropped: string[] = [];
      for (const key of keysToAdd) {
        const lower = key.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        if (merged.length >= LOREBOOK_MAX_KEYS) { dropped.push(key); continue; }
        merged.push(key);
      }
      if (dropped.length > 0) truncated.push({ id: row.id, name: row.name, dropped });
      if (merged.length === existing.length) continue;
      changes.push({ id: row.id, keys: JSON.stringify(merged) });
    }
    if (changes.length === 0) return { truncated };
    this.db.transaction((tx) => {
      for (const change of changes) {
        this.captureRevision(userId, change.id);
        const conditions = [eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, change.id)];
        if (campaignId !== undefined) conditions.push(eq(lorebookEntries.campaignId, campaignId));
        tx.update(lorebookEntries).set({ keys: change.keys, updatedAt: now }).where(and(...conditions)).run();
      }
    });
    return { truncated };
  }

  bulkSetSticky(userId: string, entryIds: string[], sticky: number, campaignId?: string) {
    this.bulkUpdate(userId, entryIds, { sticky, updatedAt: new Date().toISOString() }, campaignId);
  }

  /** Distinct tags of the campaign's UNSEALED entries — the `dramatist` tag on
   *  sealed notes revealed their existence through the tag picker. */
  getTags(userId: string, campaignId: string): string[] {
    const rows = this.db.selectDistinct({ tag: lorebookEntries.tag }).from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId), eq(lorebookEntries.sealed, 0)))
      .all();
    return rows.map(r => r.tag).filter((t): t is string => t != null && t !== "").sort();
  }

  // Activation state
  getActivationState(sessionId: string) {
    return this.db.select().from(lorebookActivationState)
      .where(eq(lorebookActivationState.sessionId, sessionId)).all();
  }

  /** All-or-nothing variant for the per-turn activation delta: a SQLITE_BUSY
   *  on the Nth row used to leave N-1 entries'
   *  sticky/cooldown committed and the rest dropped. */
  upsertActivationStates(sessionId: string, deltas: Iterable<[string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }]>) {
    this.db.transaction(() => {
      for (const [entryId, updates] of deltas) this.upsertActivationState(sessionId, entryId, updates);
    });
  }

  upsertActivationState(sessionId: string, entryId: string, input: { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }) {
    const existing = this.db.select().from(lorebookActivationState)
      .where(and(eq(lorebookActivationState.sessionId, sessionId), eq(lorebookActivationState.entryId, entryId))).get();
    if (existing) {
      // PARTIAL update: only the fields present in the delta. The old full
      // overwrite meant a cooldown-decrement delta nulled lastActivatedTurn,
      // and a sticky carry-forward zeroed a pending cooldown — sticky+cooldown
      // entries never actually served their cooldown.
      const patch: Record<string, number | null> = {};
      if (input.stickyRemaining !== undefined) patch.stickyRemaining = input.stickyRemaining;
      if (input.cooldownRemaining !== undefined) patch.cooldownRemaining = input.cooldownRemaining;
      if (input.lastActivatedTurn !== undefined) patch.lastActivatedTurn = input.lastActivatedTurn;
      if (Object.keys(patch).length === 0) return;
      this.db.update(lorebookActivationState).set(patch)
        .where(and(eq(lorebookActivationState.sessionId, sessionId), eq(lorebookActivationState.entryId, entryId))).run();
    } else {
      this.db.insert(lorebookActivationState).values({
        sessionId,
        entryId,
        stickyRemaining: input.stickyRemaining ?? 0,
        cooldownRemaining: input.cooldownRemaining ?? 0,
        lastActivatedTurn: input.lastActivatedTurn ?? null,
      }).run();
    }
  }

  /**
   * Campaign-wide delivery evidence. Activation state is keyed
   * per SESSION with no inheritance, so a new session's first stale sweep and
   * archival run saw every entry an earlier session delivered constantly as
   * "never activated": the rolling diff's prompt calls such an entry one "the
   * story has never needed" and invites a DISABLE of never-activated events, and
   * archival told its model "Last delivered into context: never".
   *
   * For each of `entryIds`, this answers whether ANY session of the campaign
   * delivered it into context (a non-null `last_activated_turn`: since
   * 2026-09-02 the turn is written only for entries that reached the model, so a
   * row carrying only a sticky or cooldown tick is not evidence) and where last.
   * Sessions in the recycle bin count: their turns were played and they can be
   * restored, and for a guard against silently disabling canon the safe error is
   * "delivered". Ids never delivered in any session of the campaign are absent
   * from the map. Per-session state stays in getActivationState().
   */
  findCampaignActivationEvidence(userId: string, campaignId: string, entryIds: string[]): Map<string, CampaignActivationEvidence> {
    const evidence = new Map<string, CampaignActivationEvidence>();
    const ids = [...new Set(entryIds)];
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = this.db.select({
        entryId: lorebookActivationState.entryId,
        sessionId: lorebookActivationState.sessionId,
        lastActivatedTurn: lorebookActivationState.lastActivatedTurn,
        activeAt: sql<string>`coalesce(${sessions.lastMessageAt}, ${sessions.updatedAt})`,
      }).from(lorebookActivationState)
        .innerJoin(sessions, eq(sessions.id, lorebookActivationState.sessionId))
        .where(and(
          eq(sessions.userId, userId),
          eq(sessions.campaignId, campaignId),
          isNotNull(lorebookActivationState.lastActivatedTurn),
          sql`${lorebookActivationState.entryId} IN (${sql.join(batch.map((id) => sql`${id}`), sql`, `)})`,
        ))
        .all();
      for (const row of rows) {
        const turn = row.lastActivatedTurn as number;
        const current = evidence.get(row.entryId);
        if (!current) {
          evidence.set(row.entryId, { sessionCount: 1, latestSessionId: row.sessionId, latestTurn: turn, latestSessionActiveAt: row.activeAt });
          continue;
        }
        current.sessionCount++;
        // Newest activity wins; equal timestamps fall back to the session id so the answer is deterministic.
        if (row.activeAt > current.latestSessionActiveAt || (row.activeAt === current.latestSessionActiveAt && row.sessionId > current.latestSessionId)) {
          current.latestSessionId = row.sessionId;
          current.latestTurn = turn;
          current.latestSessionActiveAt = row.activeAt;
        }
      }
    }
    return evidence;
  }

  clearActivationState(sessionId: string) {
    this.db.delete(lorebookActivationState)
      .where(eq(lorebookActivationState.sessionId, sessionId)).run();
  }

  clearActivationStateForEntry(entryId: string) {
    this.db.delete(lorebookActivationState)
      .where(eq(lorebookActivationState.entryId, entryId)).run();
  }

  touchLastReviewedAt(userId: string, entryIds: string[]) {
    if (entryIds.length === 0) return;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        tx.update(lorebookEntries).set({ lastReviewedAt: now })
          .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id))).run();
      }
    });
  }

  /**
   * Move an archive trigger's cold rows onto a SURVIVING trigger, in one
   * transaction. A worker that wants to disable or
   * merge away trigger `fromId` calls this first, inside its own transact(),
   * and holds its op with reason `archive-trigger` when the result is not ok.
   *
   * The target must itself be an enabled archive trigger of the same campaign:
   * a plain entry that gained `compressedRefIds` would become a trigger, and the
   * engine never injects a trigger's own content (it is replaced by the cold
   * rows), so the target's text would silently leave context. On success the
   * target lists its own cold rows then the moved ones (deduplicated), and the
   * source's `compressedRefIds` is cleared so two triggers never claim one row;
   * both writes go through update(), so the revision capture keeps the source's
   * old list under the caller's revision context. Nothing is written on refusal.
   */
  reparentArchiveTrigger(userId: string, campaignId: string, fromId: string, toId: string, now = new Date().toISOString()): ReparentArchiveTriggerResult {
    return this.transact((): ReparentArchiveTriggerResult => {
      if (fromId === toId) return { ok: false, reason: "same-entry", detail: `cannot re-parent trigger ${fromId} onto itself` };
      const from = this.findById(userId, fromId);
      const to = this.findById(userId, toId);
      if (!from || !to) return { ok: false, reason: "missing", detail: `trigger ${!from ? fromId : toId} not found` };
      if (from.campaignId !== campaignId || to.campaignId !== campaignId) {
        return { ok: false, reason: "other-campaign", detail: `trigger ${from.campaignId !== campaignId ? fromId : toId} is not in campaign ${campaignId}` };
      }
      if (!isArchiveTrigger(from)) return { ok: false, reason: "not-a-trigger", detail: `entry "${from.name}" is not an archive trigger` };
      if (!isArchiveTrigger(to)) return { ok: false, reason: "target-not-a-trigger", detail: `entry "${to.name}" is not an archive trigger; its own content would leave context if it took cold rows` };
      if (to.isEnabled !== 1) return { ok: false, reason: "target-disabled", detail: `trigger "${to.name}" is disabled and cannot keep cold rows reachable` };
      const target = parseCompressedRefIds(to.compressedRefIds);
      const moved = parseCompressedRefIds(from.compressedRefIds).filter((id) => id !== toId && id !== fromId && !target.includes(id));
      this.update(userId, toId, { compressedRefIds: JSON.stringify([...target, ...moved]), updatedAt: now });
      this.update(userId, fromId, { compressedRefIds: null, updatedAt: now });
      return { ok: true, fromId, toId, moved };
    });
  }

  /**
   * One write transaction around `fn` (BEGIN IMMEDIATE via the client default).
   * Size-watchdog events raised by create/createMany/update inside it are
   * recorded AFTER the commit and dropped on rollback; nesting is supported
   * (events flush when the outermost transact() commits, and an inner failure
   * discards only the events its own writes raised).
   */
  transact<T>(fn: () => T): T {
    const mark = this.deferredEvents.length;
    this.transactDepth++;
    let result: T;
    try {
      result = this.db.transaction(() => {
        const inner = fn();
        if (isPromiseLike(inner)) throw new Error("lorebook transactions require a synchronous callback");
        return inner;
      });
    } catch (err) {
      this.transactDepth--;
      this.deferredEvents.length = mark; // the writes rolled back — their crossings never happened
      throw err;
    }
    this.transactDepth--;
    if (this.transactDepth === 0) {
      const events = this.deferredEvents;
      this.deferredEvents = [];
      for (const event of events) recordSystemEvent(event);
    }
    return result;
  }

  private resolveSortColumn(sort?: string) {
    switch (sort) {
      case "name": return lorebookEntries.name;
      case "tag": return lorebookEntries.tag;
      case "insertion_order": return lorebookEntries.insertionOrder;
      case "scan_depth": return lorebookEntries.scanDepth;
      case "last_reviewed_at": return sql`COALESCE(${lorebookEntries.lastReviewedAt}, '2000-01-01')`;
      default: return lorebookEntries.updatedAt;
    }
  }
}
