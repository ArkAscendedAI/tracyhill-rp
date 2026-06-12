import { and, asc, desc, eq, isNull, like, or, sql } from "drizzle-orm";

import { lorebookEntries, lorebookActivationState, type DatabaseClient } from "@tracyhill-rp/db";

export class LorebookRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForCampaign(userId: string, campaignId: string, opts?: { isEnabled?: boolean; isConstant?: boolean; sort?: string; order?: string; limit?: number; offset?: number; search?: string; tag?: string }) {
    const conditions = [eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId)];
    if (opts?.isEnabled !== undefined) conditions.push(eq(lorebookEntries.isEnabled, opts.isEnabled ? 1 : 0));
    if (opts?.isConstant !== undefined) conditions.push(eq(lorebookEntries.isConstant, opts.isConstant ? 1 : 0));
    if (opts?.tag) conditions.push(eq(lorebookEntries.tag, opts.tag));
    if (opts?.search) {
      const pattern = `%${opts.search}%`;
      conditions.push(or(like(lorebookEntries.name, pattern), like(lorebookEntries.content, pattern), like(lorebookEntries.keys, pattern))!);
    }
    const sortCol = this.resolveSortColumn(opts?.sort);
    const orderFn = opts?.order === "asc" ? asc : desc;
    return this.db.select().from(lorebookEntries)
      .where(and(...conditions))
      .orderBy(orderFn(sortCol))
      .limit(opts?.limit ?? 200)
      .offset(opts?.offset ?? 0)
      .all();
  }

  countForCampaign(userId: string, campaignId: string) {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId)))
      .get();
    return row?.count ?? 0;
  }

  countPerCampaign(userId: string): Map<string, number> {
    const rows = this.db.select({ campaignId: lorebookEntries.campaignId, count: sql<number>`count(*)` })
      .from(lorebookEntries)
      .where(eq(lorebookEntries.userId, userId))
      .groupBy(lorebookEntries.campaignId)
      .all();
    const map = new Map<string, number>();
    for (const r of rows) if (r.campaignId) map.set(r.campaignId, r.count);
    return map;
  }

  listEnabledForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId), eq(lorebookEntries.isEnabled, 1)))
      .orderBy(asc(lorebookEntries.insertionOrder))
      .all();
  }

  listGlobalsForUser(userId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), isNull(lorebookEntries.campaignId), eq(lorebookEntries.isEnabled, 1)))
      .orderBy(asc(lorebookEntries.insertionOrder))
      .all();
  }

  findById(userId: string, entryId: string) {
    return this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId)))
      .get();
  }

  findByIds(userId: string, entryIds: string[]) {
    if (entryIds.length === 0) return [];
    const results: (typeof lorebookEntries.$inferSelect)[] = [];
    for (let i = 0; i < entryIds.length; i += 500) {
      const batch = entryIds.slice(i, i + 500);
      const rows = this.db.select().from(lorebookEntries)
        .where(and(eq(lorebookEntries.userId, userId), sql`${lorebookEntries.id} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`))
        .all();
      results.push(...rows);
    }
    return results;
  }

  create(input: typeof lorebookEntries.$inferInsert) {
    this.db.insert(lorebookEntries).values(input).run();
  }

  createMany(inputs: (typeof lorebookEntries.$inferInsert)[]) {
    if (inputs.length === 0) return;
    for (let i = 0; i < inputs.length; i += 500) {
      const batch = inputs.slice(i, i + 500);
      this.db.insert(lorebookEntries).values(batch).run();
    }
  }

  update(userId: string, entryId: string, input: Partial<typeof lorebookEntries.$inferInsert>) {
    this.db.update(lorebookEntries).set(input)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId))).run();
  }

  remove(userId: string, entryId: string) {
    this.db.delete(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId))).run();
  }

  removeMany(userId: string, entryIds: string[]) {
    if (entryIds.length === 0) return;
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        tx.delete(lorebookEntries)
          .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id))).run();
      }
    });
  }

  bulkSetEnabled(userId: string, entryIds: string[], enabled: boolean) {
    if (entryIds.length === 0) return;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        tx.update(lorebookEntries).set({ isEnabled: enabled ? 1 : 0, updatedAt: now })
          .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id))).run();
      }
    });
  }

  bulkSetTag(userId: string, entryIds: string[], tag: string) {
    if (entryIds.length === 0) return;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        tx.update(lorebookEntries).set({ tag, updatedAt: now })
          .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, id))).run();
      }
    });
  }

  getTags(userId: string, campaignId: string): string[] {
    const rows = this.db.selectDistinct({ tag: lorebookEntries.tag }).from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId)))
      .all();
    return rows.map(r => r.tag).filter((t): t is string => t != null).sort();
  }

  // Activation state
  getActivationState(sessionId: string) {
    return this.db.select().from(lorebookActivationState)
      .where(eq(lorebookActivationState.sessionId, sessionId)).all();
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

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
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
