import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { characterAttire, characterAttireHistory, messages, type DatabaseClient } from "@tracyhill-rp/db";
import { createId } from "../../lib/ids";

export interface AttireRecord {
  campaignId: string;
  characterName: string;
  attireDescription: string;
  lastUpdatedTurn: number;
  lastUpdatedMessageId: string | null;
  lastSeenInPresentTurn: number;
  source: string;
  updatedAt: string;
}

export interface AttireHistoryRecord {
  id: string;
  campaignId: string;
  characterName: string;
  previousAttire: string | null;
  newAttire: string;
  changedAtTurn: number;
  changedAtMessageId: string | null;
  source: string;
  reason: string | null;
  changedAt: string;
}

// `rollback` marks a value restored from history whose original writer could
// not be identified; every other source is a writer.
export type AttireSource = "wizard_seed" | "llm_inline" | "verifier" | "manual" | "rollback";

export interface AttireUpsertInput {
  campaignId: string;
  characterName: string;
  attireDescription: string;
  turn: number;
  messageId: string | null;
  source: AttireSource;
  previousAttire?: string | null;
  reason?: string | null;
  recordHistory: boolean;
}

/** Why a row's source reply no longer stands: the message row is gone, or it
 *  is a hidden sibling of a regenerated slot. */
export type DeadProvenance = "deleted" | "inactive";

export interface AttireRollbackInput {
  campaignId: string;
  /** Replies whose attire writes are withdrawn. */
  messageIds: readonly string[];
  /** When given, only these characters' rows are touched (the never-reconfirmed
   *  sweep is per row: one reply can have created a carried row and a fresh one). */
  characterNames?: readonly string[];
  /** Stored on every rollback history row. */
  reason: string;
  /** The turn the rollback happens at (the current turn estimate). */
  turn: number;
}

export interface AttireRollbackChange {
  characterName: string;
  /** The reply whose write was undone. */
  messageId: string;
  from: string;
  /** null = the record was removed (that reply had created it). */
  to: string | null;
  restoredFromMessageId: string | null;
  restoredTurn: number;
  restoredSource: string;
}

export class CharacterAttireRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForCampaign(campaignId: string): AttireRecord[] {
    return this.db.select().from(characterAttire)
      .where(eq(characterAttire.campaignId, campaignId))
      .all() as AttireRecord[];
  }

  findByCharacter(campaignId: string, characterName: string): AttireRecord | undefined {
    return this.db.select().from(characterAttire)
      .where(and(eq(characterAttire.campaignId, campaignId), eq(characterAttire.characterName, characterName)))
      .get() as AttireRecord | undefined;
  }

  findManyByCharacter(campaignId: string, names: string[]): AttireRecord[] {
    if (names.length === 0) return [];
    return this.db.select().from(characterAttire)
      .where(and(eq(characterAttire.campaignId, campaignId), inArray(characterAttire.characterName, names)))
      .all() as AttireRecord[];
  }

  /** One character's history, newest first. Two writes in the same millisecond
   *  (a continue's re-audit right behind the first audit) keep insertion order
   *  through the rowid, so "the row before this one" is always well defined. */
  listHistory(campaignId: string, characterName: string): AttireHistoryRecord[] {
    return this.db.select().from(characterAttireHistory)
      .where(and(eq(characterAttireHistory.campaignId, campaignId), eq(characterAttireHistory.characterName, characterName)))
      .orderBy(desc(characterAttireHistory.changedAt), desc(sql`rowid`))
      .all() as AttireHistoryRecord[];
  }

  /**
   * Rows whose source reply no longer stands — deleted outright, or a hidden
   * sibling of a regenerated slot. Seeds and manual edits carry
   * no message id and are never listed. Optionally limited to `names`.
   */
  listDeadProvenance(campaignId: string, names?: readonly string[]): Array<AttireRecord & { provenance: DeadProvenance }> {
    if (names && names.length === 0) return [];
    const conditions: Array<SQL | undefined> = [
      eq(characterAttire.campaignId, campaignId),
      isNotNull(characterAttire.lastUpdatedMessageId),
      or(isNull(messages.id), eq(messages.variantActive, false)),
    ];
    if (names) conditions.push(inArray(characterAttire.characterName, [...names]));
    const rows = this.db.select({ attire: characterAttire, messageId: messages.id })
      .from(characterAttire)
      .leftJoin(messages, eq(messages.id, characterAttire.lastUpdatedMessageId))
      .where(and(...conditions))
      .all();
    return rows.map((row) => ({ ...(row.attire as AttireRecord), provenance: row.messageId == null ? "deleted" as const : "inactive" as const }));
  }

  // Row + history in ONE transaction: every mutating write appends history. A
  // busy-DB failure between the two statements left a change with nothing to
  // revert to.
  upsert(input: AttireUpsertInput): void {
    this.db.transaction(() => this.upsertInTransaction(input));
  }

  private upsertInTransaction(input: AttireUpsertInput): void {
    const now = new Date().toISOString();
    const existing = this.findByCharacter(input.campaignId, input.characterName);
    const changed = !existing || existing.attireDescription.trim() !== input.attireDescription.trim();

    if (existing) {
      this.db.update(characterAttire)
        .set({
          attireDescription: input.attireDescription,
          lastUpdatedTurn: changed ? input.turn : existing.lastUpdatedTurn,
          lastUpdatedMessageId: changed ? input.messageId : existing.lastUpdatedMessageId,
          lastSeenInPresentTurn: input.turn,
          source: changed ? input.source : existing.source,
          updatedAt: now,
        })
        .where(and(
          eq(characterAttire.campaignId, input.campaignId),
          eq(characterAttire.characterName, input.characterName),
        ))
        .run();
    } else {
      this.db.insert(characterAttire).values({
        campaignId: input.campaignId,
        characterName: input.characterName,
        attireDescription: input.attireDescription,
        lastUpdatedTurn: input.turn,
        lastUpdatedMessageId: input.messageId,
        lastSeenInPresentTurn: input.turn,
        source: input.source,
        updatedAt: now,
      }).run();
    }

    if (changed && input.recordHistory) {
      this.db.insert(characterAttireHistory).values({
        id: createId(),
        campaignId: input.campaignId,
        characterName: input.characterName,
        previousAttire: existing?.attireDescription ?? input.previousAttire ?? null,
        newAttire: input.attireDescription,
        changedAtTurn: input.turn,
        changedAtMessageId: input.messageId,
        source: input.source,
        reason: input.reason ?? null,
        changedAt: now,
      }).run();
    }
  }

  /**
   * Withdraw the attire writes of the given replies. The validator writes a
   * row the moment a reply completes;
   * when that reply is later deleted, edited, truncated or hidden behind a
   * regenerated sibling, the row used to stay and <character_attire> injected
   * it at the recency end of every later turn — a hallucinated "the sword seals
   * are gone" and an alarm the user had edited out both defeated explicit OOC
   * corrections that way.
   *
   * Each affected row goes back to the value recorded before the withdrawn
   * write: the write's own history row holds it exactly (previous_attire; null
   * means the reply CREATED the record, which is then removed). A write with no
   * history row (the validator re-worded the text with changed:false, which
   * records none) falls back to the last recorded value; a character with no
   * history at all was first recorded by that reply. Provenance moves to the
   * writer that produced the restored value, so a chain of withdrawn replies
   * unwinds one write per hop. Every rollback appends its own history row
   * (source `rollback`, changed_at_message_id NULL, new_attire "" = removed),
   * so nothing is lost and the History view shows the correction.
   */
  rollbackForMessages(input: AttireRollbackInput): AttireRollbackChange[] {
    const ids = new Set(input.messageIds.filter((id) => id));
    if (ids.size === 0) return [];
    const changes: AttireRollbackChange[] = [];
    this.db.transaction(() => {
      const affected = this.affectedRows(input.campaignId, input.messageIds, input.characterNames);
      for (const start of affected) {
        let row: AttireRecord | undefined = start;
        // The bound only guards a cyclic history; a real chain is a few hops.
        for (let hop = 0; hop < 50 && row?.lastUpdatedMessageId && ids.has(row.lastUpdatedMessageId); hop++) {
          changes.push(this.undoWriteInTransaction(row, input));
          row = this.findByCharacter(input.campaignId, start.characterName);
        }
      }
    });
    return changes;
  }

  /**
   * What withdrawing the given replies would do to each affected row — the
   * first hop only (a chain continues from the restored provenance). Pure: the
   * maintenance tool previews with it on a read-only connection.
   */
  planRollback(campaignId: string, messageIds: readonly string[], characterNames?: readonly string[]): AttireRollbackChange[] {
    return this.affectedRows(campaignId, messageIds, characterNames).map((row) => this.planUndo(row));
  }

  private affectedRows(campaignId: string, messageIds: readonly string[], characterNames?: readonly string[]): AttireRecord[] {
    const ids = new Set(messageIds.filter((id) => id));
    if (ids.size === 0) return [];
    const names = characterNames ? new Set(characterNames) : null;
    return this.listForCampaign(campaignId)
      .filter((row) => row.lastUpdatedMessageId != null && ids.has(row.lastUpdatedMessageId) && (!names || names.has(row.characterName)));
  }

  private planUndo(row: AttireRecord): AttireRollbackChange {
    const undone = row.lastUpdatedMessageId!;
    const current = row.attireDescription.trim();
    const history = this.listHistory(row.campaignId, row.characterName);
    const writes = history.filter((h) => h.changedAtMessageId === undone && h.source !== "rollback");
    // A reply that wrote twice (a continue re-audits the same row) has two
    // history rows: undo the one that produced the CURRENT value first, so the
    // next hop finds the earlier one instead of the same row again.
    const write = writes.find((h) => h.newAttire.trim() === current) ?? writes[0];

    let restored: string | null;
    let earlier: AttireHistoryRecord[];
    if (write) {
      restored = write.previousAttire;
      earlier = history.slice(history.indexOf(write) + 1);
    } else {
      const last = history[0];
      restored = last && last.newAttire.trim() !== "" ? last.newAttire : null;
      earlier = history;
    }
    const restoredTrim = restored?.trim() ?? null;
    const producer = restoredTrim == null
      ? undefined
      : (earlier.find((h) => h.source !== "rollback" && h.newAttire.trim() === restoredTrim)
        ?? earlier.find((h) => h.newAttire.trim() === restoredTrim)
        ?? earlier[0]);
    const provenance = producer && producer.source !== "rollback"
      ? { turn: producer.changedAtTurn, messageId: producer.changedAtMessageId, source: producer.source }
      : { turn: producer?.changedAtTurn ?? 0, messageId: null, source: "rollback" };
    return {
      characterName: row.characterName,
      messageId: undone,
      from: row.attireDescription,
      to: restored,
      restoredFromMessageId: provenance.messageId,
      restoredTurn: provenance.turn,
      restoredSource: provenance.source,
    };
  }

  private undoWriteInTransaction(row: AttireRecord, input: AttireRollbackInput): AttireRollbackChange {
    const change = this.planUndo(row);
    const now = new Date().toISOString();
    const restored = change.to;

    this.db.insert(characterAttireHistory).values({
      id: createId(),
      campaignId: row.campaignId,
      characterName: row.characterName,
      previousAttire: row.attireDescription,
      newAttire: restored ?? "",
      changedAtTurn: input.turn,
      changedAtMessageId: null,
      source: "rollback",
      reason: `${input.reason}; undid the write from reply ${change.messageId.slice(0, 8)} at turn ${row.lastUpdatedTurn}`
        + (restored == null ? "; record removed (that reply created it)" : ""),
      changedAt: now,
    }).run();

    const where = and(eq(characterAttire.campaignId, row.campaignId), eq(characterAttire.characterName, row.characterName));
    if (restored == null) {
      this.db.delete(characterAttire).where(where).run();
    } else {
      this.db.update(characterAttire)
        .set({
          attireDescription: restored,
          lastUpdatedTurn: change.restoredTurn,
          lastUpdatedMessageId: change.restoredFromMessageId,
          source: change.restoredSource,
          updatedAt: now,
        })
        .where(where)
        .run();
    }
    return change;
  }

  touchLastSeen(campaignId: string, names: string[], turn: number): void {
    if (names.length === 0) return;
    for (const name of names) {
      this.db.update(characterAttire)
        .set({ lastSeenInPresentTurn: turn })
        .where(and(
          eq(characterAttire.campaignId, campaignId),
          eq(characterAttire.characterName, name),
        ))
        .run();
    }
  }
}
