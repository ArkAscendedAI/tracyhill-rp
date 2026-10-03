import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { messages, settledAssistantIngestions, type DatabaseClient } from "@tracyhill-rp/db";

export interface SettledAssistantSource {
  sessionId: string;
  sourceUserMessageId: string;
  sourceUserContentHash: string;
  messageId: string;
  sortOrder: number;
  contentHash: string;
  settledByMessageId: string;
}
const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");

export class MessageRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  // Variant-aware (0065): only the ACTIVE sibling of each variant group is
  // returned. NULL-group rows are singletons (variant_active defaults to 1).
  // This single predicate makes the transcript builder, getSessionDetail,
  // cost/stats, FTS rebuild, and scene-rollback all variant-aware for free.
  listForSession(userId: string, sessionId: string) {
    return this.db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantActive, true))).orderBy(asc(messages.sortOrder)).all();
  }

  /** Auto workers see only accepted exchanges through their triggering reply.
   * Interrupted and subsequently edited/swiped historical replies cannot leak
   * into a later job's window. Manual audits deliberately retain full history. */
  listForPipeline(userId: string, sessionId: string, source?: SettledAssistantSource | null) {
    const rows = this.listForSession(userId, sessionId);
    if (!source) return rows;
    const receipts = this.db.select().from(settledAssistantIngestions).where(and(
      eq(settledAssistantIngestions.userId, userId), eq(settledAssistantIngestions.sessionId, sessionId),
    )).all();
    const byId = new Map(rows.map(row => [row.id, row]));
    const accepted = new Set<string>();
    for (const receipt of receipts) {
      const assistant = byId.get(receipt.assistantMessageId), opening = byId.get(receipt.sourceUserMessageId);
      if (!assistant || assistant.role !== "assistant" || !opening || opening.role !== "user" || opening.sortOrder >= assistant.sortOrder) continue;
      if (source.sessionId === sessionId && assistant.sortOrder > source.sortOrder) continue;
      if ((receipt.contentHash !== null && receipt.contentHash !== contentHash(assistant.content))
        || (receipt.sourceUserContentHash !== null && receipt.sourceUserContentHash !== contentHash(opening.content))) continue;
      accepted.add(opening.id); accepted.add(assistant.id);
    }
    return rows.filter(row => accepted.has(row.id));
  }

  /** Characters these messages added to the session's pipeline counters: the settled replies among them, at their
   *  current length. A reply is counted once, when the next user turn settles it (ChatService.ingestSettledReplies),
   *  so an unsettled reply added nothing. */
  countedPipelineChars(userId: string, sessionId: string, messageIds: readonly string[]): number {
    if (messageIds.length === 0) return 0;
    const settled = new Set(this.db.select({ id: settledAssistantIngestions.assistantMessageId }).from(settledAssistantIngestions).where(and(
      eq(settledAssistantIngestions.userId, userId), eq(settledAssistantIngestions.sessionId, sessionId),
      inArray(settledAssistantIngestions.assistantMessageId, [...messageIds]),
    )).all().map(row => row.id));
    if (settled.size === 0) return 0;
    return this.db.select({ id: messages.id, role: messages.role, content: messages.content }).from(messages).where(and(
      eq(messages.userId, userId), eq(messages.sessionId, sessionId), inArray(messages.id, [...settled]),
    )).all().reduce((sum, row) => sum + (row.role === "assistant" ? row.content.length : 0), 0);
  }

  hasSettledAssistantIngestion(userId: string, sessionId: string, sourceUserMessageId: string): boolean {
    return Boolean(this.db.select({ messageId: settledAssistantIngestions.assistantMessageId }).from(settledAssistantIngestions).where(and(
      eq(settledAssistantIngestions.userId, userId), eq(settledAssistantIngestions.sessionId, sessionId),
      eq(settledAssistantIngestions.sourceUserMessageId, sourceUserMessageId),
    )).get());
  }

  isSettledSourceCurrent(userId: string, source: SettledAssistantSource): boolean {
    const assistant = this.findById(userId, source.sessionId, source.messageId);
    const opening = this.findById(userId, source.sessionId, source.sourceUserMessageId);
    const settling = this.findById(userId, source.sessionId, source.settledByMessageId);
    return Boolean(assistant?.role === "assistant" && assistant.variantActive && assistant.ingestionEligible
      && assistant.sortOrder === source.sortOrder && contentHash(assistant.content) === source.contentHash
      && assistant.sourceUserMessageId === source.sourceUserMessageId
      && opening?.role === "user" && opening.sortOrder < assistant.sortOrder && contentHash(opening.content) === source.sourceUserContentHash
      && settling?.role === "user" && settling.sortOrder > assistant.sortOrder);
  }

  listUnsettledAssistantSources(userId: string, sessionId: string, appendedUserMessageId: string) {
    const appended = this.findById(userId, sessionId, appendedUserMessageId);
    if (!appended || appended.role !== "user") return [];
    const rows = this.listForSession(userId, sessionId).filter(row => row.sortOrder <= appended.sortOrder);
    const receipts = new Set(this.db.select({ sourceId: settledAssistantIngestions.sourceUserMessageId })
      .from(settledAssistantIngestions).where(and(eq(settledAssistantIngestions.userId, userId), eq(settledAssistantIngestions.sessionId, sessionId))).all().map(row => row.sourceId));
    return rows.flatMap((assistant, index) => {
      if (assistant.role !== "assistant" || !assistant.ingestionEligible || !assistant.sourceUserMessageId || !assistant.content.trim()) return [];
      const opening = rows.find(row => row.id === assistant.sourceUserMessageId && row.role === "user");
      const settling = rows.slice(index + 1).find(row => row.role === "user");
      if (!opening || !settling || receipts.has(opening.id)) return [];
      const source: SettledAssistantSource = { sessionId, sourceUserMessageId: opening.id, sourceUserContentHash: contentHash(opening.content), messageId: assistant.id, sortOrder: assistant.sortOrder, contentHash: contentHash(assistant.content), settledByMessageId: settling.id };
      return [{ source, assistant, userTurn: opening.content }];
    });
  }

  /** No network work in this callback. World writes, char counters and receipt
   * commit together; a parallel extractor loses harmlessly at this boundary. */
  commitSettledAssistant(userId: string, source: SettledAssistantSource, write: () => void): boolean {
    return this.db.transaction(() => {
      if (!this.isSettledSourceCurrent(userId, source)) return false;
      if (this.hasSettledAssistantIngestion(userId, source.sessionId, source.sourceUserMessageId)) return false;
      write();
      this.db.insert(settledAssistantIngestions).values({
        sessionId: source.sessionId, userId, sourceUserMessageId: source.sourceUserMessageId,
        sourceUserContentHash: source.sourceUserContentHash,
        assistantMessageId: source.messageId, contentHash: source.contentHash,
        settledByMessageId: source.settledByMessageId, ingestedAt: new Date().toISOString(),
      }).run();
      return true;
    });
  }

  /**
   * Windowed transcript read: the `limit` most-recent ACTIVE messages,
   * or — when `before` is set — the `limit` active messages strictly older than
   * that sort_order. Fetched newest-first for the LIMIT, then reversed so callers
   * always get ascending sort_order like listForSession. When `after` is set
   * (scene jump), the `limit` active messages strictly NEWER than that sort_order,
   * read ascending directly — no reverse needed.
   */
  listWindow(userId: string, sessionId: string, opts: { before?: number; after?: number; limit: number }) {
    const conditions = [eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantActive, true)];
    if (opts.after != null) {
      conditions.push(gt(messages.sortOrder, opts.after));
      return this.db.select().from(messages)
        .where(and(...conditions))
        .orderBy(asc(messages.sortOrder))
        .limit(opts.limit)
        .all();
    }
    if (opts.before != null) conditions.push(lt(messages.sortOrder, opts.before));
    return this.db.select().from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.sortOrder))
      .limit(opts.limit)
      .all()
      .reverse();
  }

  /**
   * Full transcript INCLUDING inactive variant siblings (no variant_active
   * predicate) — used by the JSON session export only. Siblings share a
   * sort_order, so created_at breaks ties deterministically.
   */
  listAllIncludingInactiveVariants(userId: string, sessionId: string) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId)))
      .orderBy(asc(messages.sortOrder), asc(messages.createdAt))
      .all();
  }

  findById(userId: string, sessionId: string, messageId: string) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .get();
  }


  listAfterSortOrder(userId: string, sessionId: string, sortOrder: number) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), gt(messages.sortOrder, sortOrder)))
      .orderBy(asc(messages.sortOrder))
      .all();
  }

  createMessage(input: typeof messages.$inferInsert) {
    this.db.insert(messages).values(input).run();
  }

  /**
   * Insert at the session tail with the sortOrder allocated ATOMICALLY inside
   * the statement. Computing sortOrder from a pre-await snapshot let two
   * concurrent sends (or image-gen racing a stream, or a pending-merge racing
   * a GET) collide on the same sortOrder — breaking ordering, truncate, and
   * watermark locking. Returns the allocated sortOrder.
   */
  createMessageAtTail(input: Omit<typeof messages.$inferInsert, "sortOrder">): number {
    this.db.run(sql`
      INSERT INTO messages (id, session_id, user_id, role, content, thinking, model_id, source_user_message_id, ingestion_eligible,
        input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        stop_reason, stop_details_json, fast_mode, roll_override, served_model, directive_kind, scene_data,
        scene_validator_json, scene_resolution_choice, overhead_json, variant_group_id, variant_active,
        sort_order, created_at, updated_at)
      VALUES (${input.id}, ${input.sessionId}, ${input.userId}, ${input.role}, ${input.content},
        ${input.thinking ?? null}, ${input.modelId ?? null}, ${input.sourceUserMessageId ?? null}, ${input.ingestionEligible ? 1 : 0},
        ${input.inputTokens ?? null}, ${input.outputTokens ?? null}, ${input.totalTokens ?? null},
        ${input.cacheReadTokens ?? null}, ${input.cacheWriteTokens ?? null}, ${input.reasoningTokens ?? null},
        ${input.stopReason ?? null}, ${input.stopDetailsJson ?? null}, ${input.fastMode ? 1 : 0},
        ${input.rollOverride ? 1 : 0},
        ${input.servedModel ?? null}, ${input.directiveKind ?? null}, ${input.sceneData ?? null},
        ${input.sceneValidatorJson ?? null},
        ${input.sceneResolutionChoice ?? null}, ${input.overheadJson ?? null},
        ${input.variantGroupId ?? null}, ${input.variantActive === false ? 0 : 1},
        (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_id = ${input.sessionId} AND user_id = ${input.userId}),
        ${input.createdAt}, ${input.updatedAt})
    `);
    const row = this.db.select({ sortOrder: messages.sortOrder }).from(messages)
      .where(and(eq(messages.id, input.id), eq(messages.userId, input.userId))).get();
    return row?.sortOrder ?? 0;
  }

  /**
   * Insert a variant sibling at an EXPLICIT sort_order (NOT MAX+1). Used by
   * regenerate: every sibling of a variant group shares the original message's
   * sort_order so the append-only log isn't re-sequenced. The caller sets
   * variantActive / variantGroupId on the input.
   */
  createSiblingVariant(input: Omit<typeof messages.$inferInsert, "sortOrder">, sortOrder: number) {
    this.db.run(sql`
      INSERT INTO messages (id, session_id, user_id, role, content, thinking, model_id, source_user_message_id, ingestion_eligible,
        input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        stop_reason, stop_details_json, fast_mode, roll_override, served_model, directive_kind, scene_data,
        scene_validator_json, scene_resolution_choice, overhead_json, variant_group_id, variant_active,
        sort_order, created_at, updated_at)
      VALUES (${input.id}, ${input.sessionId}, ${input.userId}, ${input.role}, ${input.content},
        ${input.thinking ?? null}, ${input.modelId ?? null}, ${input.sourceUserMessageId ?? null}, ${input.ingestionEligible ? 1 : 0},
        ${input.inputTokens ?? null}, ${input.outputTokens ?? null}, ${input.totalTokens ?? null},
        ${input.cacheReadTokens ?? null}, ${input.cacheWriteTokens ?? null}, ${input.reasoningTokens ?? null},
        ${input.stopReason ?? null}, ${input.stopDetailsJson ?? null}, ${input.fastMode ? 1 : 0},
        ${input.rollOverride ? 1 : 0},
        ${input.servedModel ?? null}, ${input.directiveKind ?? null}, ${input.sceneData ?? null},
        ${input.sceneValidatorJson ?? null},
        ${input.sceneResolutionChoice ?? null}, ${input.overheadJson ?? null},
        ${input.variantGroupId ?? null}, ${input.variantActive === false ? 0 : 1},
        ${sortOrder}, ${input.createdAt}, ${input.updatedAt})
    `);
  }

  /**
   * Atomically flip the active sibling of a variant group: clear variant_active
   * on every member, then set it on the chosen one. Scoped to (user, session,
   * group) so a concurrent flip on another group can't be clobbered.
   */
  setActiveVariant(userId: string, sessionId: string, variantGroupId: string, activeMessageId: string) {
    this.db.transaction(() => {
      this.db.update(messages)
        .set({ variantActive: false })
        .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantGroupId, variantGroupId)))
        .run();
      this.db.update(messages)
        .set({ variantActive: true })
        .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantGroupId, variantGroupId), eq(messages.id, activeMessageId)))
        .run();
    });
  }

  /** All siblings of a group (active + inactive), oldest-created first — the
   * stable swipe order the ‹ n/m › chrome navigates. */
  listVariantGroup(userId: string, sessionId: string, variantGroupId: string) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantGroupId, variantGroupId)))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all();
  }

  /** Per-group sibling counts + ordered sibling ids, so getSessionDetail can
   * annotate active messages without an N+1 fan-out. Pass `groupIds` to scope
   * the query to the groups present in a transcript window — an
   * explicitly empty list short-circuits to no query at all. */
  listVariantCounts(userId: string, sessionId: string, groupIds?: string[]): Map<string, string[]> {
    if (groupIds && groupIds.length === 0) return new Map();
    const conditions = [eq(messages.userId, userId), eq(messages.sessionId, sessionId)];
    if (groupIds) conditions.push(inArray(messages.variantGroupId, groupIds));
    const rows = this.db.select({ id: messages.id, variantGroupId: messages.variantGroupId })
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all();
    const byGroup = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.variantGroupId) continue;
      const list = byGroup.get(row.variantGroupId) ?? [];
      list.push(row.id);
      byGroup.set(row.variantGroupId, list);
    }
    return byGroup;
  }

  updateMessage(userId: string, sessionId: string, messageId: string, input: Partial<typeof messages.$inferInsert>) {
    this.db.update(messages)
      .set(input)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .run();
  }

  deleteMessage(userId: string, sessionId: string, messageId: string) {
    this.db.delete(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .run();
  }

  deleteAfterSortOrder(userId: string, sessionId: string, sortOrder: number) {
    this.db.delete(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), gt(messages.sortOrder, sortOrder)))
      .run();
  }

  deleteForSession(userId: string, sessionId: string) {
    this.db.delete(messages).where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId))).run();
  }

  /** Run `fn` inside one SQLite transaction (nested calls become savepoints).
   *  Used by the regenerate persist so "insert sibling inactive → flip active"
   *  can never leave a slot half-flipped. */
  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }

  /**
   * ACTIVE message count — the single source for `sessions.message_count`.
   * It used to count every row including hidden
   * variant siblings, while the delete/truncate path counted active rows only,
   * so the sidebar "N msgs" grew on every regenerate and shrank on any delete.
   * Active-only matches `sessionStats.activeMessageCount` and what the reader
   * actually sees.
   */
  countForSession(userId: string, sessionId: string): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantActive, true))).get();
    return row?.count ?? 0;
  }

  /**
   * Scalar usage/pricing columns (no content) for every ACTIVE assistant message —
   * one cheap pass for the whole-session cost/usage aggregate without
   * dragging message bodies into JS.
   */
  listActiveAssistantUsage(userId: string, sessionId: string) {
    return this.db.select({
      modelId: messages.modelId,
      inputTokens: messages.inputTokens,
      outputTokens: messages.outputTokens,
      totalTokens: messages.totalTokens,
      cacheReadTokens: messages.cacheReadTokens,
      cacheWriteTokens: messages.cacheWriteTokens,
      reasoningTokens: messages.reasoningTokens,
      fastMode: messages.fastMode,
      overheadJson: messages.overheadJson,
    }).from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantActive, true), eq(messages.role, "assistant")))
      .all();
  }

  /**
   * Content size aggregate over ALL active messages, computed in SQLite so the
   * bodies never cross into JS. Lines = newline count + 1 per non-empty content
   * (matches the client's countLines).
   */
  aggregateActiveContent(userId: string, sessionId: string): { activeMessageCount: number; contentChars: number; contentLines: number } {
    const row = this.db.get<{ activeMessageCount: number; contentChars: number; contentLines: number }>(sql`
      SELECT COUNT(*) AS activeMessageCount,
             COALESCE(SUM(LENGTH(content)), 0) AS contentChars,
             COALESCE(SUM(CASE WHEN content = '' THEN 0 ELSE LENGTH(content) - LENGTH(REPLACE(content, char(10), '')) + 1 END), 0) AS contentLines
      FROM messages
      WHERE user_id = ${userId} AND session_id = ${sessionId} AND variant_active = 1
    `);
    return row ?? { activeMessageCount: 0, contentChars: 0, contentLines: 0 };
  }

  /**
   * Σ estimated context chars contributed by attachments on ACTIVE messages —
   * mirrors the client's estimateAttachmentContextChars (text = full length +
   * names + 32; pdf 8192; image 2048; other binary 1024).
   */
  aggregateAttachmentContextChars(userId: string, sessionId: string): number {
    const row = this.db.get<{ chars: number }>(sql`
      SELECT COALESCE(SUM(CASE
        WHEN a.content_mode = 'text' THEN LENGTH(a.content) + LENGTH(a.filename) + LENGTH(a.mime_type) + 32
        WHEN a.mime_type = 'application/pdf' THEN 8192
        WHEN a.mime_type LIKE 'image/%' THEN 2048
        ELSE 1024 END), 0) AS chars
      FROM message_attachments a
      JOIN messages m ON m.id = a.message_id AND m.user_id = a.user_id
      WHERE a.user_id = ${userId} AND a.session_id = ${sessionId} AND m.variant_active = 1
    `);
    return row?.chars ?? 0;
  }

  /** Active scene-bearing messages (id, sortOrder, sceneData) in transcript order —
   * the scene/date outline source. Small payload: no content column. */
  listActiveSceneData(userId: string, sessionId: string) {
    return this.db.select({ id: messages.id, sortOrder: messages.sortOrder, sceneData: messages.sceneData })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.variantActive, true), isNotNull(messages.sceneData)))
      .orderBy(asc(messages.sortOrder))
      .all();
  }

  searchFts(userId: string, query: string, limit = 25) {
        // Replace punctuation with SPACE (not ""): FTS5's unicode61 tokenizer
    // indexes "self-aware" as self+aware, so collapsing to "selfaware" matched
    // nothing; \p{L}\p{N} keeps non-ASCII queries (Cyrillic/CJK/accents) alive.
    const ftsQuery = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(" ");
    if (!ftsQuery) return [];
    return this.db.all<{
      id: string;
      sessionId: string;
      userId: string;
      role: string;
      content: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }>(sql`
      SELECT m.id, m.session_id as "sessionId", m.user_id as "userId", m.role, m.content,
             m.sort_order as "sortOrder", m.created_at as "createdAt", m.updated_at as "updatedAt"
      FROM messages m
      JOIN messages_fts ON m.rowid = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ${ftsQuery}
        AND m.user_id = ${userId}
        AND m.variant_active = 1
        AND s.deleted_at IS NULL
        AND s.session_type <> 'wizard'
      ORDER BY rank
      LIMIT ${limit}
    `);
  }

  /** Campaign-scoped FTS over active variants, NEWEST first (the campaign-audit
   *  refute pass pulls transcript evidence per finding — the transcript is the
   *  sole source of truth, and the most recent mention wins). OR-joins the
   *  terms: entity names rarely co-occur in one message, and AND-matching
   *  starved the verifier. */
  searchFtsForCampaign(userId: string, campaignId: string, query: string, limit = 8) {
    const ftsQuery = buildEvidenceFtsQuery(query);
    if (!ftsQuery) return [];
    // Select by RELEVANCE (bm25), present chronologically. The original
    // ORDER BY created_at DESC was the 2026-07-17 evidence bug: an OR of
    // common terms (entry keys like a protagonist's name) matches most of the
    // campaign, so recency ordering handed the audit's resolver the N newest
    // messages of the campaign — the current scene — as "evidence" for ANY
    // finding, and it correctly declined everything not mentioned there.
    // bm25 favors messages hitting multiple/rare query terms, which is what
    // "evidence about X" actually means; ubiquitous terms self-discount.
    const hits = this.db.all<{
      id: string;
      sessionId: string;
      role: string;
      content: string;
      sortOrder: number;
      createdAt: string;
    }>(sql`
      SELECT m.id, m.session_id as "sessionId", m.role, m.content,
             m.sort_order as "sortOrder", m.created_at as "createdAt"
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ${ftsQuery}
        AND messages_fts.rowid IN (
          SELECT cm.rowid FROM messages cm
          JOIN sessions s ON s.id = cm.session_id
          WHERE s.campaign_id = ${campaignId}
            AND cm.user_id = ${userId}
            AND cm.variant_active = 1)
      ORDER BY bm25(messages_fts)
      LIMIT ${limit}
    `);
    // Scoped candidate set (2026-09-27): the MATCH used to run over EVERY user's
    // messages and bm25-score each hit before the campaign join filtered them —
    // an OR of an entry pair's names and keys matched ~15.5K of 22.3K messages
    // and took 3.5–13.5 s per finding on a long campaign, synchronously, so a
    // 24-finding refute pass froze the worker loop for ~8 minutes (2026-09-27
    // 02:00–02:08Z). Restricting the rows to the campaign's active messages
    // returns the identical top hits (bm25's IDF still reads the whole index)
    // at a fraction of the cost; with the cleaned terms the same six findings
    // took 4.7 s in total instead of 47.5 s.
    // Chronological presentation reads as a timeline for the model.
    return hits.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

// Function words and possessive fragments that match nearly every message and
// only cost bm25 work ("Corin's" tokenizes to "Corin" + "s").
const EVIDENCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "these", "those", "his", "her", "hers", "their",
  "theirs", "our", "ours", "your", "yours", "its", "was", "were", "are", "been", "being", "has", "have", "had", "not",
  "but", "nor", "yet", "all", "any", "who", "whom", "whose", "what", "when", "where", "which", "while", "than", "then",
  "them", "they", "she", "him", "you", "out", "off", "over", "under", "about", "after", "before", "records", "record",
]);

/**
 * The FTS5 query for audit evidence (2026-09-27): the implicated entries' names
 * and keys, OR-joined as quoted phrases, but de-duplicated case-insensitively,
 * without function words, 1–2 character fragments or bare numbers, and capped
 * at `maxTerms` distinct words in the order given (names come first). Falls
 * back to every distinct token when cleaning leaves nothing, so a finding about
 * "Al" still gets evidence. Returns "" when the input has no word at all.
 */
export function buildEvidenceFtsQuery(query: string, maxTerms = 12): string {
  const tokens = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const pick = (keep: (token: string) => boolean) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const token of tokens) {
      const key = token.toLowerCase();
      if (seen.has(key) || !keep(token)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= maxTerms) break;
    }
    return out;
  };
  let words = pick((token) => token.length >= 3 && !EVIDENCE_STOPWORDS.has(token.toLowerCase()) && !/^\p{N}+$/u.test(token));
  if (words.length === 0) words = pick(() => true);
  return words.map((word) => `"${word}"`).join(" OR ");
}

