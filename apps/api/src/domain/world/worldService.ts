import {
  dramatistStateSchema,
  dramatistTelemetrySchema,
  type ConfirmOffscreenResponse,
  type DramatistLogResponse,
  type ProposedWorldEvent,
  type WorldStatusResponse,
  type WorldTickRequest,
  type WorldTickRun,
  type ScheduledBeat,
} from "@tracyhill-rp/contracts";
import { getConfiguredDefaultModelId } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import type { UserRepository } from "../users/userRepository";
import type { CampaignRepository } from "../campaigns/campaignRepository";
import type { SessionRepository } from "../workspace/sessionRepository";
import type { MessageRepository } from "../chat/messageRepository";
import { PipelineTranscriptInput, type PipelineTranscriptManifest } from "../chat/pipelineTranscriptInput";
import type { CharacterDrivesRepository } from "../chat/characterDrivesRepository";
import type { PipelineRunRepository } from "../pipeline/pipelineRunRepository";
import type { LorebookRepository } from "../context/lorebookRepository";
import type { AdversarialWorldRepository } from "./adversarialWorldRepository";
import type { EmbeddingService } from "../context/embeddingService";
import type { ContextEngine } from "../context/contextEngine";
import { canTransitionBeat, type ScheduledBeatRepository, type BeatRow, type BeatStatus } from "./scheduledBeatRepository";
import { confirmOffscreenEntry } from "./offscreen";
import { applyWorldEvents } from "./worldApply";
import { embedModelFromOverrides, resolveCampaignEmbedModel } from "../context/embedModelResolver";
import { latestSceneDate, parseInWorldDate, parseWorldClock, serializeWorldClock } from "./worldClock";

const WORLD_TICK_PRIORITY = 50;

interface TickDetails {
  mode: "catchup" | "skip";
  fromInWorld: string | null;
  toInWorld: string;
  guidance?: string | null;
  worldTickModel: string;
  autoApply: boolean;
  embeddingModel: string;
  dramatistEnabled?: boolean;
  dramatistModel?: string;
  dramatistIntensity?: "restrained" | "standard" | "bold";
  proposed?: ProposedWorldEvent[];
  dropped?: Array<{ summary: string; reason: string }>;
  workerEffort?: string;
  openaiFastMode?: boolean;
  appliedAt?: string | null;
  appliedCount?: number | null;
  expectedWorldClockJson?: string | null;
  settledSource?: import("../chat/messageRepository").SettledAssistantSource;
  transcriptInput?: PipelineTranscriptManifest;
}

export class WorldService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly runs: PipelineRunRepository,
    private readonly drives: CharacterDrivesRepository,
    private readonly beats: ScheduledBeatRepository,
    private readonly lorebook: LorebookRepository,
    private readonly contextEngine: ContextEngine | null,
    private readonly embedding: EmbeddingService | null,
    private readonly kick: (() => void) | null,
    /** Phase 7: carried through to applyWorldEvents so a manually-applied tick
     *  moves trust exactly like an auto-applied one. Without it the review path
     *  would silently diverge from the worker path. */
    private readonly adversarialWorld: AdversarialWorldRepository | null = null,
  ) {}

  private requireCampaign(userId: string, campaignId: string) {
    if (!this.users.findById(userId)) throw new HttpError(401, "authentication required");
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  /** Latest parseable scene date across the campaign's sessions (most recent
   *  session first). `anchorEpoch` (the world-clock watermark) re-anchors a
   *  year-less scene date to the campaign's year — see parseInWorldDate. */
  private storyNow(userId: string, campaignId: string, anchorEpoch: number | null = null): { label: string; epoch: number | null } | null {
    const sessionRows = this.sessions.listForCampaign(userId, campaignId)
      .sort((a, b) => ((a.lastMessageAt ?? "") < (b.lastMessageAt ?? "") ? 1 : -1));
    for (const s of sessionRows) {
      const found = latestSceneDate(this.messages.listForSession(userId, s.id), anchorEpoch);
      if (found) return found;
    }
    return null;
  }

  status(userId: string, campaignId: string): WorldStatusResponse {
    const campaign = this.requireCampaign(userId, campaignId);
    const worldClock = parseWorldClock(campaign.worldClockJson);
    const storyNow = this.storyNow(userId, campaignId, worldClock?.simulatedThroughEpoch ?? null);
    const gapDays = worldClock?.simulatedThroughEpoch != null && storyNow?.epoch != null
      ? Math.round(((storyNow.epoch - worldClock.simulatedThroughEpoch) / 86_400_000) * 10) / 10
      : null;
    // Hidden-until-fire applies to the owner: sealed (Dramatist-scheme) beats
    // never reach the player-facing status surface — a staged ambush visible
    // in the Beats chip is a spoiler. Behind the Curtain is their only reader;
    // duePending deliberately keeps them so injection still fires.
    //
    // Listed: armed (`pending`) beats plus MANUALLY surfaced ones (`surfaced`
    // with no firedMessageId — the Android world screen's "✓ surfaced" button).
    // A manual surface is not a chat claim: markMessagePlayed/releaseMessageClaims
    // key on firedMessageId and never touch it, so without this it vanished from
    // every player surface in a silent limbo. It stays visible with
    // lifecycle "fired" until the player marks it played or dismissed.
    const pending = this.beats.listForCampaign(campaignId)
      .filter((b) => b.sealed !== 1 && (b.status === "pending" || (b.status === "surfaced" && b.firedMessageId == null)));
    const latest = this.runs.findLatestByKindAndCampaign("world_tick", campaignId);
    return {
      campaignId,
      worldClock,
      storyNow,
      gapDays,
      beats: pending.map((b) => this.toBeat(b, storyNow?.epoch ?? null)),
      latestTick: latest ? this.toTickRun(latest) : null,
    };
  }

  /**
   * Read what the phase-7 producers have written. Admin-only, same as the
   * Dramatist log: threats, consequences, clocks and standings are all
   * spoiler-bearing.
   */
  inspectAdversarial(userId: string, campaignId: string) {
    this.requireCampaign(userId, campaignId);
    const user = this.users.findById(userId);
    if (user?.role !== "admin") throw new HttpError(403, "admin required");
    if (!this.adversarialWorld) throw new HttpError(503, "adversarial world repository unavailable");
    const settings = this.contextEngine?.resolveSettings({
      contextOverridesJson: this.sessions.listForCampaign(userId, campaignId)[0]?.contextOverridesJson ?? null,
    });
    return this.adversarialWorld.inspect(campaignId, settings?.worldStance ?? 1);
  }

  /** Dismiss a consequence the extraction pass got wrong. This is what makes
   *  auto-recording safe: the ledger is authoritative AND correctable. */
  dismissConsequence(userId: string, campaignId: string, consequenceId: string) {
    this.requireCampaign(userId, campaignId);
    const user = this.users.findById(userId);
    if (user?.role !== "admin") throw new HttpError(403, "admin required");
    if (!this.adversarialWorld) throw new HttpError(503, "adversarial world repository unavailable");
    if (!this.adversarialWorld.deleteConsequence(campaignId, consequenceId)) {
      throw new HttpError(404, "consequence not found");
    }
    return { dismissed: consequenceId };
  }

  behindCurtain(userId: string, campaignId: string): DramatistLogResponse {
    const campaign = this.requireCampaign(userId, campaignId);
    const user = this.users.findById(userId);
    if (user?.role !== "admin") throw new HttpError(403, "admin required");
    const storyNowEpoch = this.storyNow(userId, campaignId, parseWorldClock(campaign.worldClockJson)?.simulatedThroughEpoch ?? null)?.epoch ?? null;
    const state = (() => {
      if (!campaign.dramatistStateJson) return dramatistStateSchema.parse({});
      try {
        const parsed = dramatistStateSchema.safeParse(JSON.parse(campaign.dramatistStateJson));
        return parsed.success ? parsed.data : dramatistStateSchema.parse({});
      } catch { return dramatistStateSchema.parse({}); }
    })();
    const ticks = this.runs.listForCampaign(userId, campaignId)
      .filter((run) => run.kind === "world_tick")
      .slice(0, 50)
      .map((run) => {
        const details = safeObject(run.detailsJson);
        const parsed = dramatistTelemetrySchema.safeParse(details?.dramatist);
        return {
          runId: run.id,
          status: run.status as DramatistLogResponse["ticks"][number]["status"],
          requestedAt: run.requestedAt,
          completedAt: run.completedAt ?? null,
          error: run.error ?? null,
          models: {
            worldTickModel: typeof details?.worldTickModel === "string" ? details.worldTickModel : null,
            dramatistModel: typeof details?.dramatistModel === "string" ? details.dramatistModel : null,
          },
          telemetry: parsed.success ? parsed.data : null,
        };
      });
    const schemes = this.drives.listForCampaign(campaignId)
      .filter((record) => record.sealed && record.scheme)
      .map((record) => ({ characterName: record.characterName, scheme: record.scheme!, updatedAt: record.updatedAt }));
    const sealedNotes = this.lorebook.listSealedForCampaign(userId, campaignId).map((entry) => ({
      id: entry.id, name: entry.name, content: entry.content, comment: entry.comment ?? null,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    }));
    return {
      campaignId,
      state,
      ticks,
      beats: this.beats.listForCampaign(campaignId).map((beat) => this.toBeat(beat, storyNowEpoch)),
      schemes,
      sealedNotes,
    };
  }

  tick(userId: string, campaignId: string, req: WorldTickRequest): WorldStatusResponse {
    const campaign = this.requireCampaign(userId, campaignId);
    if (this.runs.hasQueuedOrRunningByKindAndCampaign("world_tick", campaignId)) {
      throw new HttpError(409, "a world tick is already queued or running for this campaign");
    }
    // The Engine panel stores worldTickModel/worldTickAutoApply as SESSION
    // overrides (like every other dial), so resolve through the requesting
    // session — campaign defaults alone would silently ignore the panel.
    const session = req.sessionId ? this.sessions.findById(userId, req.sessionId) : null;
    if (req.sessionId && (!session || session.campaignId !== campaignId)) {
      throw new HttpError(404, "session not found in this campaign");
    }
    const settings = this.contextEngine?.resolveSettings({ contextOverridesJson: session?.contextOverridesJson ?? null });
    const worldClock = parseWorldClock(campaign.worldClockJson);
    const clockEpoch = worldClock?.simulatedThroughEpoch ?? null;
    const storyNow = this.storyNow(userId, campaignId, clockEpoch);

    let fromLabel: string | null;
    let toLabel: string;
    if (req.mode === "catchup") {
      fromLabel = req.fromOverride?.trim() || worldClock?.simulatedThrough || null;
      const to = req.toOverride?.trim() || storyNow?.label;
      if (!to) throw new HttpError(422, "no parseable in-world story date found — provide a manual 'to' date");
      toLabel = to;
      if (!fromLabel) {
        // First tick: initialize the watermark to story-now; nothing to simulate yet.
        this.campaigns.updateWorldClock(campaignId, serializeWorldClock(toLabel, storyNow?.epoch ?? null));
        return this.status(userId, campaignId);
      }
      // Year-less labels anchor to the campaign's position: `from` to the clock
      // (or story-now), `to` to `from`.
      const fromEpoch = parseInWorldDate(fromLabel, clockEpoch ?? storyNow?.epoch ?? null);
      const toEpoch = parseInWorldDate(toLabel, fromEpoch ?? storyNow?.epoch ?? null);
      // An ANCHORED clock never ticks to a label without an
      // epoch. Applying such a window stored a watermark with a null epoch, which
      // switched off the backward-clock guard and un-anchored every year-less
      // label after it (a state one campaign reached). Skip mode
      // already 422s on an unparseable base; catch-up now refuses before anything
      // is queued and says why. A campaign whose calendar never parses (no clock
      // epoch) keeps its label-only flow.
      if (toEpoch == null && clockEpoch != null) {
        throw new HttpError(422, `the story's newest scene date "${toLabel}" is not a calendar date the clock can read (the world is simulated through ${worldClock!.simulatedThrough}) — provide a manual 'to' date; a relative date such as "two days later" cannot advance the clock`);
      }
      if (fromLabel === toLabel || (fromEpoch != null && toEpoch != null && toEpoch <= fromEpoch)) {
        throw new HttpError(400, "the world is already caught up to the story");
      }
    } else {
      // Skip counts from story-now — unless the watermark is already
      // AHEAD of story-now (a prior skip the scene date hasn't caught up with),
      // in which case it counts from the watermark: counting from story-now
      // would compute a window the ledger already covers and then move the
      // clock BACKWARD on apply. An explicit fromOverride still wins.
      // (An unparseable story date keeps the 422 below — the clock is not a guess
      // for it; the owner supplies a manual 'from'.)
      const clockAhead = worldClock?.simulatedThrough && clockEpoch != null && (storyNow == null || (storyNow.epoch != null && clockEpoch > storyNow.epoch));
      const base = req.fromOverride?.trim() || (clockAhead ? worldClock!.simulatedThrough : storyNow?.label) || worldClock?.simulatedThrough;
      if (!base) throw new HttpError(422, "no in-world date to skip from — provide a manual 'from' date");
      const baseEpoch = parseInWorldDate(base, clockEpoch ?? storyNow?.epoch ?? null);
      if (baseEpoch == null) throw new HttpError(422, `cannot parse in-world date "${base}" — provide a manual 'from' date instead`);
      const ms = req.skip!.value * (req.skip!.unit === "hours" ? 3_600_000 : req.skip!.unit === "days" ? 86_400_000 : 604_800_000);
      const target = new Date(baseEpoch + ms);
      // Never re-simulate: the target must land after the current watermark.
      if (clockEpoch != null && target.getTime() <= clockEpoch) {
        throw new HttpError(400, `the world is already simulated through ${worldClock!.simulatedThrough} — a skip must land after it`);
      }
      // Hour-scale skips need the time in the label or a 3-hour skip collapses
      // into the same date string as its base.
      toLabel = req.skip!.unit === "hours"
        ? target.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
        : target.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      fromLabel = base;
    }

    const details: TickDetails = {
      mode: req.mode,
      expectedWorldClockJson: campaign.worldClockJson,
      fromInWorld: fromLabel,
      toInWorld: toLabel,
      guidance: req.guidance?.trim() || null,
      worldTickModel: settings?.worldTickModel ?? getConfiguredDefaultModelId() ?? "claude-sonnet-4-6-bridge",
      autoApply: settings?.worldTickAutoApply ?? false,
      // A tick without a session embeds its applied events under the campaign's
      // newest session's dial, the rule every session-less path uses;
      // it used to take the contract's shipped id.
      embeddingModel: session
        ? settings?.embeddingModel ?? embedModelFromOverrides(session.contextOverridesJson)
        : resolveCampaignEmbedModel(this.sessions, userId, campaignId),
      dramatistEnabled: settings?.dramatistEnabled ?? false,
      dramatistModel: settings?.dramatistModel ?? getConfiguredDefaultModelId() ?? "claude-sonnet-4-6-bridge",
      dramatistIntensity: settings?.dramatistIntensity ?? "restrained",
      workerEffort: settings?.workerEffort ?? "model-max",
      openaiFastMode: settings?.openaiFastModeEnabled ?? false,
      appliedAt: null,
    };
    const now = new Date().toISOString();
    this.runs.createRun({
      id: createId(), userId, campaignId, sessionId: req.sessionId ?? null, kind: "world_tick",
      priority: WORLD_TICK_PRIORITY, status: "queued",
      detailsJson: JSON.stringify(details), requestedAt: now, updatedAt: now,
    });
    this.kick?.();
    return this.status(userId, campaignId);
  }

  async apply(userId: string, campaignId: string, runId: string, events: ProposedWorldEvent[]): Promise<WorldStatusResponse> {
    this.requireCampaign(userId, campaignId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.kind !== "world_tick" || run.campaignId !== campaignId) throw new HttpError(404, "world tick run not found");
    if (run.status !== "completed") throw new HttpError(400, `run is ${run.status} — only a completed tick can be applied`);
    const details = safeDetails(run.detailsJson);
    if (!details) throw new HttpError(422, "run details unreadable");
    if (details.appliedAt) throw new HttpError(409, "this tick was already applied");

    await applyWorldEvents(
      { lorebook: this.lorebook, beats: this.beats, campaigns: this.campaigns, embedding: this.embedding, drives: this.drives, adversarialWorld: this.adversarialWorld },
      {
        userId, campaignId, tickRunId: runId, events,
        windowFrom: details.fromInWorld, windowTo: details.toInWorld,
        embedModelId: details.embeddingModel,
        expectedWorldClockJson: details.expectedWorldClockJson,
        // Stamped INSIDE the apply transaction: a failed apply leaves
        // no canon AND no appliedAt, so the retry is a clean first attempt; a
        // committed apply can never be re-applied.
        onApplied: (result) => {
          // Another process may have applied a legacy tick without a clock
          // watermark after the initial read. Recheck the run under the same
          // write transaction; throwing here rolls back its duplicate canon.
          const current = this.runs.findById(userId, runId);
          if (!current || current.kind !== "world_tick" || current.campaignId !== campaignId || current.status !== "completed" || current.detailsJson !== run.detailsJson) {
            throw new HttpError(409, "this tick changed or was already applied — reload before applying events");
          }
          if (details.settledSource && !this.messages.isSettledSourceCurrent(userId, details.settledSource)) {
            throw new HttpError(409, "the kept reply that supplied this tick changed — run a fresh tick before applying events");
          }
          if (details.settledSource) {
            try {
              if (!details.transcriptInput) throw new Error("missing input manifest");
              new PipelineTranscriptInput(this.messages, userId, details.settledSource, details.transcriptInput).assertCurrent();
            } catch {
              throw new HttpError(409, "the accepted transcript that supplied this tick changed — run a fresh tick before applying events");
            }
          }
          const appliedAt = new Date().toISOString();
          this.runs.updateRun(runId, {
            detailsJson: JSON.stringify({ ...details, appliedAt, appliedCount: result.created }),
            updatedAt: appliedAt,
          });
        },
      },
    );
    return this.status(userId, campaignId);
  }

  setBeatStatus(userId: string, campaignId: string, beatId: string, status: BeatStatus): WorldStatusResponse {
    this.requireCampaign(userId, campaignId);
    const beat = this.beats.findById(campaignId, beatId);
    if (!beat) throw new HttpError(404, "beat not found");
    // Sealed beats are Dramatist-managed: invisible to the status surface and
    // not manually dismissable/playable — their lifecycle belongs to the
    // claim/play/release machinery and Behind the Curtain review.
    if (beat.sealed === 1) throw new HttpError(403, "sealed beats are Dramatist-managed");
    // State machine: played/dismissed are terminal — a re-armed played
    // beat fires the same consequence into prose again. See BEAT_STATUS_TRANSITIONS.
    const from = beat.status as BeatStatus;
    if (!canTransitionBeat(from, status)) {
      const terminal = from === "played" || from === "dismissed";
      throw new HttpError(409, `beat is ${from} — cannot set ${status}${terminal ? " (played and dismissed are terminal)" : ""}`);
    }
    if (this.beats.setStatus(campaignId, beatId, status) === "illegal") {
      throw new HttpError(409, "beat status changed concurrently — reload and retry");
    }
    return this.status(userId, campaignId);
  }

  /**
   * "Confirm as canon" for a provisional offscreen entry.
   * The web and Android buttons used to rewrite the marker JSON client-side and
   * PATCH it through the generic entry update: they flipped `provisional` but
   * never stamped `confirmedAt`, so the ledger had two "established" shapes and
   * the rolling diff's CONFIRM_OFFSCREEN was the only path through the single
   * marker writer. This is the server-side path for both clients; the write
   * runs under the process-default `manual` revision context, which is what an
   * owner confirmation is.
   */
  confirmOffscreen(userId: string, campaignId: string, entryId: string): ConfirmOffscreenResponse {
    this.requireCampaign(userId, campaignId);
    const row = this.lorebook.findById(userId, entryId);
    if (!row || row.campaignId !== campaignId) throw new HttpError(404, "lorebook entry not found in this campaign");
    if (!confirmOffscreenEntry(this.lorebook, userId, entryId)) {
      throw new HttpError(409, "entry is not a provisional offscreen event");
    }
    const confirmed = this.lorebook.findById(userId, entryId);
    return { entryId, confirmedAt: readConfirmedAt(confirmed?.comment ?? null) ?? new Date().toISOString() };
  }

  private toBeat(b: BeatRow, storyNowEpoch: number | null): ScheduledBeat {
    return {
      id: b.id,
      campaignId: b.campaignId,
      description: b.description,
      afterInworld: b.afterInworld ?? null,
      afterEpoch: b.afterEpoch ?? null,
      sourceEventEntryId: b.sourceEventEntryId ?? null,
      sourceTickRunId: b.sourceTickRunId ?? null,
      class: b.class as ScheduledBeat["class"],
      severity: b.severity,
      timing: b.timing as ScheduledBeat["timing"],
      citationType: b.citationType as ScheduledBeat["citationType"],
      citationId: b.citationId ?? null,
      sealed: b.sealed === 1,
      firedMessageId: b.firedMessageId ?? null,
      status: b.status as ScheduledBeat["status"],
      lifecycle: b.status === "pending" ? "armed" : b.status === "surfaced" ? "fired" : b.status === "played" ? "played" : "dismissed",
      // A DATELESS beat ("soon") is due immediately; a beat whose date string
      // didn't parse is NOT auto-due (never guess) — it stays visible with its
      // label for manual surfacing. Mirrors ScheduledBeatRepository.duePending.
      due: (b.afterEpoch == null && !b.afterInworld) || (b.afterEpoch != null && storyNowEpoch != null && b.afterEpoch <= storyNowEpoch),
      createdAt: b.createdAt,
    };
  }

  private toTickRun(run: { id: string; status: string; detailsJson: string | null; error: string | null; requestedAt: string }): WorldTickRun {
    const details = safeDetails(run.detailsJson);
    return {
      runId: run.id,
      status: run.status as WorldTickRun["status"],
      mode: details?.mode ?? null,
      fromInWorld: details?.fromInWorld ?? null,
      toInWorld: details?.toInWorld ?? null,
      guidance: details?.guidance ?? null,
      proposed: details?.proposed ?? null,
      dropped: details?.dropped ?? null,
      appliedAt: details?.appliedAt ?? null,
      appliedCount: details?.appliedCount ?? null,
      error: run.error ?? null,
      requestedAt: run.requestedAt,
    };
  }
}

function safeDetails(json: string | null): TickDetails | null {
  if (!json) return null;
  try { return JSON.parse(json) as TickDetails; } catch { return null; }
}

function readConfirmedAt(comment: string | null): string | null {
  const marker = safeObject(comment);
  return typeof marker?.confirmedAt === "string" ? marker.confirmedAt : null;
}

function safeObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
