import { characterNameKey } from "../chat/characterNames";
import { driveSheetSchema, type ProposedWorldEvent } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { estimateTokens } from "../context/lorebookTokenEstimator";
import type { LorebookRepository } from "../context/lorebookRepository";
import type { EmbeddingService } from "../context/embeddingService";
import type { CampaignRepository } from "../campaigns/campaignRepository";
import type { CharacterDrivesRepository } from "../chat/characterDrivesRepository";
import type { AdversarialWorldRepository } from "./adversarialWorldRepository";
import type { ScheduledBeatRepository } from "./scheduledBeatRepository";
import { supersedeOffscreenEntry } from "./offscreen";
import { parseInWorldDate, parseWorldClock, serializeWorldClock } from "./worldClock";
import { HttpError } from "../../lib/httpError";

// Living World Phase 2 — the single apply path for world-tick events, shared by
// the manual review flow (worldService) and the worker's autoApply mode.
//
// Each applied event becomes an `events` lorebook entry:
// - knownBy = the actors/witnesses ONLY → the context renderer routes it to the
//   narrator-only section whenever the knowers aren't present (the epistemic core:
//   the narrator can steer consequences the player hasn't discovered).
// - comment = machine markers {offscreen, provisional, sourceTickId, visibility}.
//   Provisional entries are excluded from consolidation until confirmed; if live
//   play contradicts an unsurfaced provisional event, disable/edit it (two-tier
//   canon: the transcript always wins).
//
// Atomicity: every write below — supersedes, entry creates,
// drive upserts + trust, beats, the watermark, and the caller's `onApplied`
// stamp — runs in ONE SQLite transaction on the shared connection. Before this
// they were independent autocommit statements: a throw on event 3 of 5 (a
// hand-edited over-cap sheet failing driveSheetSchema, any SQLite error) left
// events 1-2 as canon with no watermark and no appliedAt, and the owner's retry
// created them AGAIN (lorebook entries have no fingerprint guard; only beats
// do) while decaying the same wants' pressure twice. Only the embedding call
// stays outside — it is async and non-fatal.

export interface WorldApplyDeps {
  lorebook: LorebookRepository;
  beats: ScheduledBeatRepository;
  campaigns: CampaignRepository;
  embedding?: EmbeddingService | null;
  // Offscreen-flow (2026-07-17): applied events feed BACK into drive sheets so
  // agendas and future ticks see offscreen progress. Optional so legacy call
  // sites keep compiling; effects are skipped without it.
  drives?: CharacterDrivesRepository | null;
  // Phase 7: the sole trust producer lives on the want-satisfaction path below.
  // Optional so legacy call sites keep compiling; trust simply does not move
  // without it.
  adversarialWorld?: AdversarialWorldRepository | null;
}

export interface WorldApplyResult { created: number; beats: number; superseded: number; entryIds: string[] }

export interface WorldApplyInput {
  userId: string;
  campaignId: string;
  tickRunId: string;
  events: ProposedWorldEvent[];
  windowFrom: string | null;
  windowTo: string; // the watermark advances here
  embedModelId?: string | null;
  expectedWorldClockJson?: string | null;
  /** Runs INSIDE the write transaction after the watermark advances, with the
   *  same counts the call resolves to. The manual review path stamps the run's
   *  `appliedAt` here so "this tick was applied" and the canon it produced
   *  commit — or roll back — together. Must be synchronous. */
  onApplied?: (result: WorldApplyResult) => void;
}

export async function applyWorldEvents(deps: WorldApplyDeps, input: WorldApplyInput): Promise<WorldApplyResult> {
  const now = new Date().toISOString();
  const embedTargets: { id: string; userId: string; content: string }[] = [];
  let beatCount = 0;
  let superseded = 0;
  // Year-less in-world dates: the window's own labels anchor each
  // other (`windowTo` to `windowFrom`), and a beat's `afterInWorld` anchors to
  // the window END — the tick's simulated-through date is the campaign's
  // position in story time when the beat is armed. Beat dates anchor FORWARD:
  // a not-before date never means a past year, so
  // "January 15" armed on June 4 is next January, not a beat due at once; the
  // window START is the floor — a date inside the window the tick just
  // simulated has already landed and is due now.

  // Revision provenance: the repository's context is ONE mutable field
  // on the instance the whole API process shares (LorebookService, ChatService,
  // …). Set it for this batch and ALWAYS restore the process default — before
  // the finally, a single manual "Advance the world" apply left every later
  // owner edit revisioned as this world tick until the API restarted. The
  // worker re-sets its own context before each of its write batches
  // (dramatistPass does), so the default restore is correct there too.
  deps.lorebook.setRevisionContext({ source: "world_tick", pipelineRunId: input.tickRunId });
  try {
    deps.lorebook.transact(() => {
      const campaign = deps.campaigns.findById(input.userId, input.campaignId);
      if (!campaign) throw new HttpError(404, "campaign not found");
      const currentClock = parseWorldClock(campaign.worldClockJson);
      const clockAnchor = currentClock?.simulatedThroughEpoch ?? null;
      const windowFromEpoch = parseInWorldDate(input.windowFrom, clockAnchor);
      const windowToEpoch = parseInWorldDate(input.windowTo, windowFromEpoch ?? clockAnchor);
      const beatAnchor = windowToEpoch ?? windowFromEpoch ?? clockAnchor;
      if ((input.expectedWorldClockJson !== undefined && input.expectedWorldClockJson !== campaign.worldClockJson) ||
          (clockAnchor != null && windowToEpoch != null && windowToEpoch < clockAnchor)) {
        throw new HttpError(409, "the world clock changed since this tick was proposed — run a fresh tick against the current world");
      }
      // An anchored clock never advances to a label without
      // an epoch — the watermark would lose its epoch, the backward guard above
      // would be skipped from then on, and year-less labels would lose their
      // anchor. The manual catch-up refuses such a window before queueing it; this
      // is the same rule for the worker's automatic path and for runs queued
      // earlier. A clock that never had an epoch keeps its label-only flow.
      if (clockAnchor != null && windowToEpoch == null) {
        throw new HttpError(422, `cannot advance the world clock to "${input.windowTo}" — that label is not a calendar date the clock can read, and the world is simulated through ${currentClock!.simulatedThrough}; run a fresh tick with a manual 'to' date`);
      }
      for (const event of input.events) {
        const entryId = createId();
        const windowLabel = input.windowFrom ? `${input.windowFrom} → ${input.windowTo}` : input.windowTo;
        const content = `OFFSCREEN (${windowLabel}): ${event.summary}\n\n${event.detail}`;
        // Supersede-don't-duplicate: this event replaces a prior offscreen fact —
        // the old entry is disabled (revisioned) and chained, so the ledger keeps
        // exactly one current entry per fact. Campaign-scoped: the id
        // comes from the client on the manual path.
        if (event.supersedesEntryId && supersedeOffscreenEntry(deps.lorebook, input.userId, event.supersedesEntryId, entryId, input.campaignId)) superseded++;
        const keys = [...new Set([...event.surfaceHints, ...event.actors])].filter(Boolean).slice(0, 12);
        deps.lorebook.create({
          id: entryId,
          userId: input.userId,
          campaignId: input.campaignId,
          name: `Offscreen — ${event.summary.slice(0, 80)}`,
          tag: "events",
          content,
          comment: JSON.stringify({ offscreen: true, provisional: true, sourceTickId: input.tickRunId, visibility: event.visibility, window: windowLabel }),
          keys: JSON.stringify(keys),
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
          excludeRecursion: 1,
          preventRecursion: 1,
          delayUntilRecursion: 0,
          tokensEstimate: estimateTokens(content),
          knownBy: JSON.stringify(event.knownBy),
          matchOptionsJson: null,
          legacySource: null,
          createdAt: now,
          updatedAt: now,
        });
        embedTargets.push({ id: entryId, userId: input.userId, content });

        // Drive feedback: offscreen progress updates the knowers' sheets so the
        // want stops regenerating (pressure decay + stamp). The sheet stays
        // authored by its normal writers; this only touches the affected want.
        if (deps.drives && event.driveEffects.length > 0) {
          for (const effect of event.driveEffects) {
            // Name key fallback (2026-09-27): a tick that writes "Sheriff Doran Vale" still finds "Doran Vale".
            const record = deps.drives.findByCharacter(input.campaignId, effect.character)
              ?? (() => { const m = deps.drives.listForCampaign(input.campaignId).filter((r) => characterNameKey(r.characterName) === characterNameKey(effect.character)); return m.length === 1 ? m[0] : undefined; })();
            if (!record || record.sealed) continue;
            const wantIdx = record.sheet.wants.findIndex((w) => {
              const a = w.text.toLocaleLowerCase();
              const b = effect.wantText.toLocaleLowerCase();
              return a.includes(b) || b.includes(a);
            });
            if (wantIdx < 0) continue;
            const sheet = driveSheetSchema.parse(structuredClone(record.sheet));
            const want = sheet.wants[wantIdx]!;
            const stamp = effect.effect === "satisfied"
              ? `(done offscreen ${windowLabel}${effect.note ? `: ${effect.note}` : ""})`
              : `(advanced offscreen ${windowLabel}${effect.note ? `: ${effect.note}` : ""})`;
            want.pressure = effect.effect === "satisfied" ? 0 : Math.max(0, want.pressure - 2);
            if (!want.text.includes("offscreen")) want.text = `${want.text} ${stamp}`.slice(0, 400);
            deps.drives.upsert({
              campaignId: input.campaignId, characterName: record.characterName, sheet,
              turn: null, messageId: null, source: "worker", recordHistory: true,
            });
            // THE ONLY PRODUCER OF TRUST IN THE SYSTEM (phase 7, deliberately).
            //
            // Grudge is written from prose by the extraction pass, because a biased
            // reader UNDER-detects slights and that errs safe. Trust is the opposite: a
            // biased reader over-detects warmth, and warmth-on-demand is the exact
            // failure this whole system exists to remove. So trust is never read out of
            // prose — it moves only on mechanical evidence, and a want actually
            // reaching "satisfied" is the strongest mechanical evidence available.
            //
            // Small, too: +2 against a decay of 3 per tick means trust needs sustained
            // satisfaction to climb at all, which is the arithmetic form of "one kind
            // act doesn't erase a pattern".
            if (deps.adversarialWorld && effect.effect === "satisfied") {
              deps.adversarialWorld.adjustStanding(input.campaignId, record.characterName, { trust: 2 });
            }
          }
        }

        if (event.scheduledBeat) {
          // createIfNovel: tick events are proposed against the offscreen ledger, but
          // the beat they arm has no such advance-or-supersede discipline of its own —
          // an identical description means this consequence is already armed or played.
          const wasNovel = deps.beats.createIfNovel({
            id: createId(),
            campaignId: input.campaignId,
            description: event.scheduledBeat.description,
            afterInworld: event.scheduledBeat.afterInWorld || null,
            afterEpoch: parseInWorldDate(event.scheduledBeat.afterInWorld, beatAnchor, { yearless: "forward", notBefore: windowFromEpoch ?? clockAnchor ?? beatAnchor }),
            sourceEventEntryId: entryId,
            sourceTickRunId: input.tickRunId,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          });
          if (wasNovel) beatCount++;
        }
      }

      // Advance the watermark — the window is now simulated, applied or not-in-full.
      deps.campaigns.updateWorldClock(input.campaignId, serializeWorldClock(input.windowTo, windowFromEpoch ?? clockAnchor));
      input.onApplied?.({ created: embedTargets.length, beats: beatCount, superseded, entryIds: embedTargets.map((entry) => entry.id) });
    });
  } finally {
    deps.lorebook.setRevisionContext({ source: "manual", pipelineRunId: null });
  }

  if (deps.embedding && embedTargets.length > 0 && input.embedModelId) {
    await deps.embedding.indexEntries(embedTargets, input.embedModelId).catch(() => {
      // Re-embed failure is non-fatal (embedding service records its own system
      // event); stale vectors backfill via the reembed tool.
    });
  }
  return { created: embedTargets.length, beats: beatCount, superseded, entryIds: embedTargets.map((entry) => entry.id) };
}
