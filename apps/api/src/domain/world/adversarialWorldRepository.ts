import { createHash, randomInt, randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { activeThreats, campaignConsequences, characterDrives, threatClocks, type DatabaseClient } from "@tracyhill-rp/db";

import { clampStance, outcomeBiasMultiplier, lethalityAuthorized } from "./gritContract";

/**
 * Adversarial World state (phases 3-6).
 *
 * Everything here exists because prose cannot enforce itself. A positivity-biased
 * model asked to follow through on a threat, honour a death, or let a scheme
 * advance offscreen will reliably decline all three, and it will do so while
 * appearing to comply. State the model does not own is the only version that
 * holds.
 *
 * Every entry point is gated on worldStance, so at the shipped default (1) none
 * of it runs: no threat registered, no consequence recorded, no clock advanced,
 * no nemesis promoted.
 *
 * IDEMPOTENCY (2026-09-02): the mutating producers here — `burnOpportunities`,
 * `adjustStanding`, `promoteNemesis` — carry NO per-turn key and mutate
 * unconditionally on every call. They must therefore only be called on an
 * APPEND (a genuinely new turn); regenerate / continue / edit-regenerate reuse
 * the source user message and would stack the side effects (a second burned
 * opportunity, a second rank, a second grudge increment) for the same turn.
 * The gate lives at the CALLERS (chatService, `plan.kind === "append"`), not
 * here — the repository does not know what kind of turn it is serving.
 * `registerThreat` / `recordConsequence` are effectively idempotent through
 * their callers' fingerprint dedupe.
 *
 * RETENTION: nothing prunes terminal rows (expired/attempted/defused threats,
 * resolved/abandoned clocks, the consequence ledger). Growth is bounded by real
 * in-world events, `inspect()` reads the newest 100 consequences, and the whole
 * campaign's rows go with `deleteForCampaign`. A sweep is not worth a new code
 * path until a campaign shows a table in the thousands.
 */

export type ThreatRow = typeof activeThreats.$inferSelect;
export type ConsequenceRow = typeof campaignConsequences.$inferSelect;
export type ClockRow = typeof threatClocks.$inferSelect;

export interface ContestedOutcome {
  /** True when <user> gets what they were reaching for. */
  success: boolean;
  /** 1-100. Persisted in the injected block so a result is auditable after the fact. */
  roll: number;
  /** The number the roll had to beat, after modifiers and stance weighting. */
  target: number;
  /** Human-readable modifier trail, for the injected constraint and the log. */
  basis: string[];
}

/** 1-100 derived from a seed string. Uniform enough for a d100 (the modulo bias
 *  over a 48-bit draw is far below one part in a million) and stable forever, which
 *  is the property that matters here. */
function seededRoll(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return (digest.readUIntBE(0, 6) % 100) + 1;
}

export class AdversarialWorldRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  // ─── Phase 3: threat fuse ──────────────────────────────────────────────────

  /** Arm a threat. No-op below stance 3, which is where Threat Follow-Through
   *  starts injecting — registering fuses the prose never mentions would produce
   *  verifier findings for a rule the model was never given. */
  registerThreat(input: {
    campaignId: string; sessionId: string | null; sourceCharacter: string;
    target: string; statedAct: string; worldStance: number; opportunities?: number;
  }): ThreatRow | null {
    if (clampStance(input.worldStance) < 3) return null;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      sourceCharacter: input.sourceCharacter.trim(),
      target: input.target.trim(),
      statedAct: input.statedAct.trim().slice(0, 1000),
      opportunitiesRemaining: input.opportunities ?? 2,
      status: "armed" as const,
      resolution: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    this.db.insert(activeThreats).values(row).run();
    return row;
  }

  listArmedThreats(campaignId: string): ThreatRow[] {
    return this.db.select().from(activeThreats)
      .where(and(eq(activeThreats.campaignId, campaignId), eq(activeThreats.status, "armed")))
      .all();
  }

  /**
   * Burn one opportunity for every armed threat whose SOURCE is on stage. A
   * threat from an absent character must not expire while they are away — the
   * fuse measures their chances to act, not elapsed turns.
   *
   * Returns the threats that just ran out, which is the signal for the verifier
   * to flag and the Dramatist to convert into an armed beat.
   *
   * NOT idempotent: every call burns. With the default of two opportunities, a
   * regenerate that re-ran this would expire a fuse the character never had a
   * second chance to act on — callers gate on append-only turns (header note).
   */
  burnOpportunities(campaignId: string, presentCharacters: string[]): ThreatRow[] {
    const present = new Set(presentCharacters.map((n) => n.trim().toLocaleLowerCase()).filter(Boolean));
    if (present.size === 0) return [];
    const now = new Date().toISOString();
    const expired: ThreatRow[] = [];
    for (const threat of this.listArmedThreats(campaignId)) {
      if (!present.has(threat.sourceCharacter.toLocaleLowerCase())) continue;
      const remaining = threat.opportunitiesRemaining - 1;
      if (remaining > 0) {
        this.db.update(activeThreats)
          .set({ opportunitiesRemaining: remaining, updatedAt: now })
          .where(eq(activeThreats.id, threat.id)).run();
      } else {
        this.db.update(activeThreats)
          .set({ status: "expired", opportunitiesRemaining: 0, updatedAt: now, resolvedAt: now,
                 resolution: "fuse ran out without a concrete attempt" })
          .where(eq(activeThreats.id, threat.id)).run();
        expired.push({ ...threat, status: "expired", opportunitiesRemaining: 0 });
      }
    }
    return expired;
  }

  resolveThreat(id: string, status: "attempted" | "defused", resolution: string): void {
    const now = new Date().toISOString();
    this.db.update(activeThreats)
      .set({ status, resolution: resolution.slice(0, 500), updatedAt: now, resolvedAt: now })
      .where(eq(activeThreats.id, id)).run();
  }

  // ─── Phase 3: contested outcomes, resolved in code ─────────────────────────

  /**
   * Resolve a contested action server-side and COMMIT BEFORE REVEAL: the caller
   * states the stake, this returns the result, and the result is injected as a
   * fact to render.
   *
   * Models measurably cannot roll — 10 of 11 frontier models fail every requested
   * distribution, and Claude answered "7" to pick-1-to-10 in 90 of 100 trials —
   * and Claude specifically is documented fudging rolls and retconning defeats.
   * Any design where the model both rolls and narrates re-admits the bias through
   * the back door, so the model never sees a choice point at all.
   */
  resolveContested(input: {
    baseTarget?: number;
    worldStance: number;
    /** Positive favours <user>; each entry is surfaced in the basis trail. */
    modifiers?: { label: string; value: number }[];
    /**
     * When present the roll is DERIVED from this string instead of drawn fresh.
     *
     * This exists because regeneration would otherwise be a dice re-roll, which
     * is the same plot-armour hole the consequence ledger closes: swipe until the
     * attack misses. Seeding on the user-message id makes every variant of one
     * turn resolve identically, so a re-roll can change the prose and never the
     * outcome. It stays unpredictable to the player (they cannot compute the
     * digest→roll mapping) and auditable to us (same seed, same number, and the
     * roll is printed in the injected block).
     *
     * SCOPE OF THE GUARANTEE (2026-09-02): the seed stabilises the ROLL only.
     * `target` is recomputed from the caller's inputs every time — the
     * classifier's difficulty (a fresh model call per generation) and live
     * standings — so a regenerate can meet the same roll against a different
     * window and flip the verdict. Full outcome stability needs the caller to
     * persist the classified contest + modifiers keyed on the source message;
     * until then "same outcome on regenerate" holds only while those inputs
     * do not move between variants.
     */
    seed?: string;
    /**
     * Owner roll override (the composer 🎲 toggle). The verdict is forced to
     * success but the roll is STILL drawn and printed — the injected block then
     * shows a number that may sit above the target next to a basis line naming
     * the override, so an overridden turn is auditable from the transcript
     * alone rather than looking like an ordinary lucky roll. Success here means
     * <user>'s side prevails: callers on the antagonist side inherit the
     * inversion they already apply.
     */
    forceSuccess?: boolean;
  }): ContestedOutcome {
    const stance = clampStance(input.worldStance);
    const basis: string[] = [];
    let target = input.baseTarget ?? 50;
    for (const mod of input.modifiers ?? []) {
      if (!mod.value) continue;
      target += mod.value;
      basis.push(`${mod.label} ${mod.value > 0 ? "+" : ""}${mod.value}`);
    }
    // Stance weighting is applied to the success WINDOW rather than the roll, so a
    // hostile world narrows what counts as success instead of quietly rerolling.
    const weighted = Math.round(target * outcomeBiasMultiplier(stance));
    const clamped = Math.max(5, Math.min(95, weighted));
    if (clamped !== target) basis.push(`world stance ${stance} → ${clamped}%`);
    // CSPRNG, not Math.random: this is the one number in the system that must not
    // be predictable or nudged. Seeded callers get a stable draw instead — see the
    // `seed` doc above for why regeneration requires that.
    const roll = input.seed ? seededRoll(input.seed) : randomInt(1, 101);
    if (input.forceSuccess) {
      basis.push("owner override — resolved in <user>'s favour");
      return { success: true, roll, target: clamped, basis };
    }
    return { success: roll <= clamped, roll, target: clamped, basis };
  }

  // ─── Phase 4: consequence ledger ───────────────────────────────────────────

  /** Record an irreversible fact. Deaths require stance >= 3; maimings, losses and
   *  ruin are available from stance 2 where consequence realism starts. */
  recordConsequence(input: {
    campaignId: string; sessionId: string | null; kind: ConsequenceRow["kind"];
    subject: string; detail: string; messageId?: string | null; worldStance: number;
  }): ConsequenceRow | null {
    const stance = clampStance(input.worldStance);
    if (input.kind === "death" && !lethalityAuthorized(stance)) return null;
    if (stance < 2) return null;
    const row = {
      id: randomUUID(),
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      kind: input.kind,
      subject: input.subject.trim(),
      detail: input.detail.trim().slice(0, 2000),
      messageId: input.messageId ?? null,
      aftermath: null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(campaignConsequences).values(row).run();
    return row;
  }

  /** Newest first. `limit: null` reads the whole ledger — the producer's dedupe
   *  set must cover every recorded row, or an old death re-records once 200
   *  newer rows have pushed it out of the window (2026-09-02). */
  listConsequences(campaignId: string, limit: number | null = 40): ConsequenceRow[] {
    const query = this.db.select().from(campaignConsequences)
      .where(eq(campaignConsequences.campaignId, campaignId))
      .orderBy(desc(campaignConsequences.createdAt));
    return limit === null ? query.all() : query.limit(limit).all();
  }

  /**
   * Delete a consequence outright.
   *
   * This is the reversibility that licenses recording consequences automatically
   * instead of queueing them for approval. A row here is authoritative and
   * self-reinforcing — it is re-injected as settled fact, so the next variant is
   * told to honour it — which means a false positive has to be removable or the
   * extraction pass is not safe to run unattended.
   *
   * A hard delete rather than a soft flag on purpose: the semantic is "this never
   * happened", and a dismissed row that lingered in the ledger would keep shaping
   * the prompt.
   */
  deleteConsequence(campaignId: string, id: string): boolean {
    const existing = this.db.select({ id: campaignConsequences.id }).from(campaignConsequences)
      .where(and(eq(campaignConsequences.campaignId, campaignId), eq(campaignConsequences.id, id))).get();
    if (!existing) return false;
    this.db.delete(campaignConsequences).where(eq(campaignConsequences.id, id)).run();
    return true;
  }

  /** Everything the owner needs to see what the producers have written. */
  inspect(campaignId: string, worldStance: number) {
    return {
      worldStance: clampStance(worldStance),
      threats: this.listArmedThreats(campaignId),
      consequences: this.listConsequences(campaignId, 100),
      clocks: this.listActiveClocks(campaignId),
      standings: this.listStandings(campaignId).filter((s) => s.grudge > 0 || s.trust > 0),
    };
  }

  /**
   * The constraint that closes the regeneration hole. Re-injected on regenerate
   * and variant paths so a re-roll cannot resurrect what the ledger records —
   * without this, swipe IS plot armour and every other lethality mechanism is
   * decorative.
   */
  buildConsequenceConstraint(campaignId: string): string | null {
    const rows = this.listConsequences(campaignId, 25);
    if (rows.length === 0) return null;
    const lines = rows.map((row) => `- ${row.subject}: ${row.kind}: ${row.detail}`);
    return [
      "<established_consequences>",
      "These are settled facts of this campaign. They hold in this reply regardless of how the scene is retold.",
      ...lines,
      "</established_consequences>",
    ].join("\n");
  }

  // ─── Phase 5: emotional inertia ────────────────────────────────────────────

  /**
   * Move a character's standing toward <user>. Grudge decays slowly and trust
   * accrues slowly BY DESIGN: "one kind act doesn't erase a pattern" is a request
   * in prose and arithmetic here, and it is the mechanical backstop against the
   * apology-flips-everything failure.
   *
   * NOT idempotent (each call adds the delta; callers gate on append-only
   * turns — header note). Returns the number of rows changed: standing lives
   * on the character's drive sheet, so a slight against a roster character
   * WITHOUT a sheet updates nothing, and the caller should say so rather than
   * let the grudge evaporate silently.
   *
   * Leaves the sheet's `updatedAt` alone, like
   * decayStandings: that stamp means "the sheet was written", and the drive
   * worker's user-edit guard reads a user-authored sheet with a fresh stamp as
   * an edit made during its run — a slight recorded mid-run made it skip the
   * character's re-emission and blame an edit nobody made.
   */
  adjustStanding(campaignId: string, characterName: string, delta: { grudge?: number; trust?: number }): number {
    const g = delta.grudge ?? 0;
    const t = delta.trust ?? 0;
    if (!g && !t) return 0;
    const result = this.db.update(characterDrives)
      .set({
        grudge: sql`MAX(0, MIN(100, ${characterDrives.grudge} + ${g}))`,
        trust: sql`MAX(0, MIN(100, ${characterDrives.trust} + ${t}))`,
      })
      .where(and(eq(characterDrives.campaignId, campaignId), eq(characterDrives.characterName, characterName)))
      .run();
    return result.changes;
  }

  /**
   * Standings are read here rather than on the drives repository because
   * `DriveRecord` deliberately does not project these columns — grudge and trust
   * are adversarial-world state, not part of the editable drive sheet, and keeping
   * them off the sheet is what stops a worker rewriting them as prose.
   */
  listStandings(campaignId: string): Array<{ name: string; grudge: number; trust: number }> {
    return this.db.select({
      name: characterDrives.characterName,
      grudge: characterDrives.grudge,
      trust: characterDrives.trust,
    }).from(characterDrives).where(eq(characterDrives.campaignId, campaignId)).all();
  }

  /** Per-tick decay. Grudge fades at a third the rate trust does — a slight is
   *  remembered longer than a kindness, which is what stops a villain drifting
   *  amiable across a long campaign. */
  decayStandings(campaignId: string): void {
    this.db.update(characterDrives)
      .set({
        grudge: sql`MAX(0, ${characterDrives.grudge} - 1)`,
        trust: sql`MAX(0, ${characterDrives.trust} - 3)`,
      })
      .where(eq(characterDrives.campaignId, campaignId)).run();
  }

  // ─── Phase 6: nemesis records ──────────────────────────────────────────────

  /**
   * Promote an antagonist who beat <user>. Rank rises, a scar is recorded, and
   * familiarity increments so this one resurfaces ahead of a stranger — the
   * Nemesis-system property that makes a recurring villain feel earned rather
   * than randomly re-rolled.
   *
   * NOT idempotent: every call is another rank/scar/familiarity increment, and
   * the antagonist roll is seeded on the source message, so a regenerate that
   * re-ran this would promote AGAIN for the same win — callers gate on
   * append-only turns (header note).
   *
   * Write-only as of 2026-09-02: `nemesis_rank`, `scars_json` and `familiarity`
   * have no reader yet (not the antagonist brief, the intent prompt, `inspect()`,
   * or either client). The increments are kept so the record is honest when a
   * consumer is wired; wiring one is a separate decision.
   */
  promoteNemesis(campaignId: string, characterName: string, scar: string, worldStance: number): void {
    if (clampStance(worldStance) < 3) return;
    const row = this.db.select().from(characterDrives)
      .where(and(eq(characterDrives.campaignId, campaignId), eq(characterDrives.characterName, characterName)))
      .get();
    if (!row) return;
    const scars: string[] = (() => {
      try { const parsed = JSON.parse(row.scarsJson ?? "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; }
      catch { return []; }
    })();
    scars.push(scar.trim().slice(0, 300));
    this.db.update(characterDrives)
      .set({
        nemesisRank: Math.min(10, row.nemesisRank + 1),
        familiarity: row.familiarity + 1,
        scarsJson: JSON.stringify(scars.slice(-8)),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(characterDrives.campaignId, campaignId), eq(characterDrives.characterName, characterName)))
      .run();
  }

  // ─── Phase 6: clocks and fronts ────────────────────────────────────────────

  createClock(input: {
    campaignId: string; name: string; impulse: string; total?: number; ownerCharacter?: string | null;
    schemeStepKey?: string | null;
  }): ClockRow {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      campaignId: input.campaignId,
      name: input.name.trim().slice(0, 200),
      impulse: input.impulse.trim().slice(0, 600),
      filled: 0,
      total: Math.max(2, Math.min(12, input.total ?? 6)),
      ownerCharacter: input.ownerCharacter ?? null,
      schemeStepKey: input.schemeStepKey ?? null,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(threatClocks).values(row).run();
    return row;
  }

  listActiveClocks(campaignId: string): ClockRow[] {
    return this.db.select().from(threatClocks)
      .where(and(eq(threatClocks.campaignId, campaignId), eq(threatClocks.status, "active"))).all();
  }

  /**
   * Advance every active clock. Called from the world tick, so clocks progress
   * whether or not <user> engages with them — a threat that only moves when
   * looked at is not a threat, which is the whole reason clocks exist rather than
   * "remember to escalate" in a prompt.
   *
   * Returns clocks that just filled: those force their beat.
   */
  advanceClocks(campaignId: string, worldStance: number, pacing: "steady" | "relaxed" | "chaotic" = "steady", tickOrdinal = 0): ClockRow[] {
    if (clampStance(worldStance) < 2) return [];
    // The same clock pool under a different pacing curve is a different campaign.
    // Chaotic deliberately decouples from the cycle so the owner cannot predict
    // the rhythm — unpredictability the model is incapable of producing itself.
    const segments = pacing === "relaxed"
      ? (tickOrdinal % 2 === 0 ? 1 : 0)
      : pacing === "chaotic"
        ? randomInt(0, 4)
        : 1;
    if (segments === 0) return [];
    const now = new Date().toISOString();
    const filledNow: ClockRow[] = [];
    for (const clock of this.listActiveClocks(campaignId)) {
      const filled = clock.filled + segments;
      if (filled >= clock.total) {
        this.db.update(threatClocks)
          .set({ filled: clock.total, status: "filled", updatedAt: now })
          .where(eq(threatClocks.id, clock.id)).run();
        filledNow.push({ ...clock, filled: clock.total, status: "filled" });
      } else {
        this.db.update(threatClocks).set({ filled, updatedAt: now })
          .where(eq(threatClocks.id, clock.id)).run();
      }
    }
    return filledNow;
  }

  resolveClock(id: string, status: "resolved" | "abandoned"): void {
    this.db.update(threatClocks).set({ status, updatedAt: new Date().toISOString() })
      .where(eq(threatClocks.id, id)).run();
  }

  /** Live clock pressure for the turn: the impulse strings keep offscreen
   *  antagonists acting in character instead of idling between appearances. */
  buildClockBlock(campaignId: string, worldStance: number): string | null {
    if (clampStance(worldStance) < 2) return null;
    const clocks = this.listActiveClocks(campaignId);
    if (clocks.length === 0) return null;
    const lines = clocks.map((c) => {
      const who = c.ownerCharacter ? `${c.ownerCharacter}: ` : "";
      return `- ${who}${c.name} [${c.filled}/${c.total}]: ${c.impulse}`;
    });
    return [
      "<offscreen_pressure>",
      "These are advancing whether or not they are looked at. Where one touches the current scene, let it show.",
      ...lines,
      "</offscreen_pressure>",
    ].join("\n");
  }
}
