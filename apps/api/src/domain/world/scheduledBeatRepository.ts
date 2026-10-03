import { and, eq, desc, inArray } from "drizzle-orm";

import { scheduledBeats, type DatabaseClient } from "@tracyhill-rp/db";

export type BeatRow = typeof scheduledBeats.$inferSelect;
export type BeatStatus = "pending" | "surfaced" | "played" | "dismissed";

/**
 * Beat state machine (2026-09-02). Lifecycle: armed (`pending`) → fired
 * (`surfaced`, normally with `firedMessageId` via claimForMessage) → `played` or
 * `dismissed`. `played` and `dismissed` are TERMINAL: re-arming a played beat
 * would fire the same consequence into prose again (the duplicate class the
 * novelty check in createIfNovel exists to prevent), and an owner veto is not re-armable.
 * `surfaced → pending` is the release path (a failed generation gives the beat
 * back). Same-state writes are accepted as no-ops so a double tap is harmless.
 */
export const BEAT_STATUS_TRANSITIONS: Readonly<Record<BeatStatus, readonly BeatStatus[]>> = {
  pending: ["surfaced", "played", "dismissed"],
  surfaced: ["played", "dismissed", "pending"],
  played: [],
  dismissed: [],
};

export function canTransitionBeat(from: BeatStatus, to: BeatStatus): boolean {
  return from === to || BEAT_STATUS_TRANSITIONS[from].includes(to);
}

/** Stable identity for a beat description, mirroring the threat/consequence
 *  fingerprint discipline: lowercase, punctuation stripped, whitespace folded.
 *  Full text (no word cap) — the observed duplicate class is verbatim re-derivation
 *  (clock re-fires, dramatist re-advances), and a prefix cap would false-positive
 *  on legitimately distinct beats that share an opening clause. */
export function beatFingerprint(description: string): string {
  // Unicode-aware: the ASCII class printed an all-non-Latin
  // description as "", which switched the novelty check off for it.
  return description.toLocaleLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").split(/\s+/).filter(Boolean).join(" ");
}

export class ScheduledBeatRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForCampaign(campaignId: string, status?: BeatStatus): BeatRow[] {
    const conditions = [eq(scheduledBeats.campaignId, campaignId)];
    if (status) conditions.push(eq(scheduledBeats.status, status));
    return this.db.select().from(scheduledBeats)
      .where(and(...conditions))
      .orderBy(desc(scheduledBeats.createdAt))
      .all();
  }

  /** Pending beats due at the given story clock. A DATELESS beat ("soon") is due
   *  immediately; a beat whose date string didn't parse is NOT auto-due (never
   *  guess) — it stays listed for manual surfacing. Mirrors worldService.toBeat. */
  duePending(campaignId: string, storyNowEpoch: number | null): BeatRow[] {
    return this.listForCampaign(campaignId, "pending").filter((b) =>
      (b.afterEpoch == null && !b.afterInworld) || (b.afterEpoch != null && storyNowEpoch != null && b.afterEpoch <= storyNowEpoch),
    ).sort((a, b) => {
      const classRank = (value: string) => value === "complication" ? 0 : value === "telegraph" ? 1 : 2;
      return classRank(a.class) - classRank(b.class) || b.severity - a.severity || (a.createdAt < b.createdAt ? -1 : 1);
    });
  }

  /**
   * Create unless a beat with the same description fingerprint already exists for
   * the campaign — in ANY status. Every world-producer path (clock fires, dramatist
   * fire proposals, scheme-step armsBeat, applied tick events) must arm through
   * this — there is deliberately no bare create() (removed 2026-09-02: a
   * public unguarded insert beside this rule was a standing footgun). The
   * producers re-derive their material from campaign state
   * each tick, so an identical description is a re-derivation of a development
   * that already fired (or was dismissed — an owner veto is not re-armable), never
   * a legitimately new event. Before this was enforced, 20 duplicate
   * escalations once reached the prose.
   */
  createIfNovel(input: typeof scheduledBeats.$inferInsert): boolean {
    // Never skip the novelty check on an empty print: a description
    // that is pure punctuation compares by its trimmed lower-case text instead.
    const identity = (description: string) => beatFingerprint(description) || description.trim().toLocaleLowerCase();
    const print = identity(input.description ?? "");
    if (print && this.listForCampaign(input.campaignId).some((b) => identity(b.description) === print)) {
      return false;
    }
    this.db.insert(scheduledBeats).values(input).run();
    return true;
  }

  updateFromDramatist(campaignId: string, beatId: string, input: {
    description: string;
    class: "texture" | "telegraph" | "complication";
    severity: number;
    timing: "when_due" | "fire_during_scene";
    citationType: "thread" | "beat" | "scheme" | "concealment" | "none";
    citationId: string | null;
    sourceTickRunId: string;
    afterInworld: string | null;
    afterEpoch: number | null;
    sealed: boolean;
  }): boolean {
    const result = this.db.update(scheduledBeats).set({
      description: input.description,
      class: input.class,
      severity: input.severity,
      timing: input.timing,
      citationType: input.citationType,
      citationId: input.citationId,
      sourceTickRunId: input.sourceTickRunId,
      afterInworld: input.afterInworld,
      afterEpoch: input.afterEpoch,
      sealed: input.sealed ? 1 : 0,
      updatedAt: new Date().toISOString(),
    }).where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.id, beatId), eq(scheduledBeats.status, "pending"))).run();
    return result.changes > 0;
  }

  findById(campaignId: string, beatId: string): BeatRow | undefined {
    return this.db.select().from(scheduledBeats)
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.id, beatId)))
      .get();
  }

  claimForMessage(campaignId: string, beatId: string, messageId: string): boolean {
    const result = this.db.update(scheduledBeats)
      .set({ status: "surfaced", firedMessageId: messageId, updatedAt: new Date().toISOString() })
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.id, beatId), eq(scheduledBeats.status, "pending")))
      .run();
    return result.changes > 0;
  }

  listForFiredMessage(campaignId: string, messageId: string): BeatRow[] {
    return this.db.select().from(scheduledBeats)
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.firedMessageId, messageId)))
      .orderBy(desc(scheduledBeats.severity), desc(scheduledBeats.createdAt)).all()
      .filter((beat) => beat.status === "surfaced" || beat.status === "played");
  }

  markMessagePlayed(campaignId: string, messageId: string): number {
    const result = this.db.update(scheduledBeats)
      .set({ status: "played", updatedAt: new Date().toISOString() })
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.firedMessageId, messageId), eq(scheduledBeats.status, "surfaced")))
      .run();
    return result.changes;
  }

  releaseMessageClaims(campaignId: string, messageId: string): number {
    const result = this.db.update(scheduledBeats)
      .set({ status: "pending", firedMessageId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.firedMessageId, messageId), eq(scheduledBeats.status, "surfaced")))
      .run();
    return result.changes;
  }

  /**
   * Manual status change, guarded by BEAT_STATUS_TRANSITIONS at the SQL level
   * (`WHERE status IN (states that may move to `status`)`) so a concurrent
   * claim/play cannot slip a terminal beat back to `pending`. Returns
   * `"updated"`, `"noop"` (already in that state), or `"illegal"` (not found,
   * or the current state has no transition to `status` — the caller resolves
   * which via findById).
   */
  setStatus(campaignId: string, beatId: string, status: BeatStatus): "updated" | "noop" | "illegal" {
    const current = this.findById(campaignId, beatId);
    if (!current) return "illegal";
    if (current.status === status) return "noop";
    const allowedFrom = (Object.keys(BEAT_STATUS_TRANSITIONS) as BeatStatus[]).filter((from) => BEAT_STATUS_TRANSITIONS[from].includes(status));
    if (allowedFrom.length === 0) return "illegal";
    // A transition back to `pending` gives the beat back: drop the
    // chat claim's message id the way releaseMessageClaims does, so the row
    // does not carry a stale firedMessageId into its next claim.
    const result = this.db.update(scheduledBeats)
      .set({ status, updatedAt: new Date().toISOString(), ...(status === "pending" ? { firedMessageId: null } : {}) })
      .where(and(eq(scheduledBeats.campaignId, campaignId), eq(scheduledBeats.id, beatId), inArray(scheduledBeats.status, allowedFrom)))
      .run();
    return result.changes > 0 ? "updated" : "illegal";
  }
}
