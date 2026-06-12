import { and, eq, inArray } from "drizzle-orm";

import { characterAttire, characterAttireHistory, type DatabaseClient } from "@tracyhill-rp/db";
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

export interface AttireUpsertInput {
  campaignId: string;
  characterName: string;
  attireDescription: string;
  turn: number;
  messageId: string | null;
  source: "wizard_seed" | "llm_inline" | "verifier" | "manual";
  previousAttire?: string | null;
  reason?: string | null;
  recordHistory: boolean;
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

  upsert(input: AttireUpsertInput): void {
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

  deleteForCampaign(campaignId: string): void {
    this.db.delete(characterAttireHistory).where(eq(characterAttireHistory.campaignId, campaignId)).run();
    this.db.delete(characterAttire).where(eq(characterAttire.campaignId, campaignId)).run();
  }

  history(campaignId: string, characterName: string): Array<typeof characterAttireHistory.$inferSelect> {
    return this.db.select().from(characterAttireHistory)
      .where(and(
        eq(characterAttireHistory.campaignId, campaignId),
        eq(characterAttireHistory.characterName, characterName),
      ))
      .all();
  }
}
