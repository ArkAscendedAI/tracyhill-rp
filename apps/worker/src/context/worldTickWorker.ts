import { pipelineInputsForRun } from "./settledSourceGuard";
import type { PipelineTranscriptManifest } from "../../../api/src/domain/chat/pipelineTranscriptInput";
import { randomUUID } from "node:crypto";
import { schemeStepKey } from "../../../api/src/domain/world/schemeStepIdentity";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { AdversarialWorldRepository } from "../../../api/src/domain/world/adversarialWorldRepository";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";
import { contextSettingsSchema, proposedWorldEventSchema, type AntagonistScheme, type ProposedWorldEvent } from "@tracyhill-rp/contracts";

import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { CharacterDrivesRepository } from "../../../api/src/domain/chat/characterDrivesRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { ScheduledBeatRepository } from "../../../api/src/domain/world/scheduledBeatRepository";
import { applyWorldEvents } from "../../../api/src/domain/world/worldApply";
import { isProvisionalMarker, listActiveOffscreen, parseOffscreenMarker, renderOffscreenLedger } from "../../../api/src/domain/world/offscreen";
import { parseInWorldDate } from "../../../api/src/domain/world/worldClock";
import { stripOocBlocks } from "../../../api/src/domain/context/stripOoc";
import { latestSceneDate, parseWorldClock } from "../../../api/src/domain/world/worldClock";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { withRetry, withDeadline, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { runDramatistPass, writeSealedSchemeAdvanceNote, type DramatistPassDetails } from "./dramatistPass";
import { resolveWorkerModel } from "./workerModel";

const MAX_EVENTS = 5;
// The contract default of both dials (packages/contracts/src/context.ts), used
// only when a dial is ABSENT and no deployment default is configured.
const DEFAULT_TICK_MODEL = "claude-sonnet-4-6-bridge";
// How many pending on-screen beats the neutral pass is told to leave alone.
const MAX_ON_SCREEN_BEATS = 12;

const PROPOSE_SYSTEM = `You simulate the OFFSCREEN WORLD of an ongoing roleplay campaign. The story's camera has been elsewhere for a window of in-world time; you decide what the NPCs did with that time, driven by their drive sheets (wants, goals, off-page projects).

Output at most ${MAX_EVENTS} offscreen events as JSON. Fewer, sharper events beat many vague ones. At most ONE event per lead NPC.

For EACH event:
{
  "actors": ["Wilkins", "the coroner"],          // who did it / witnessed it
  "summary": "Wilkins bribed the coroner",        // one line
  "detail": "2-6 sentences: what happened, where, why (tied to the actor's drives), and its consequences so far.",
  "knownBy": ["Wilkins", "the coroner"],          // ONLY those who know it happened — this powers hidden-world fog of war. The player's character must NOT be included unless they'd genuinely know.
  "visibility": "hidden",                          // hidden (no outward trace) | rumored (whispers exist) | observable (visible effects exist)
  "surfaceHints": ["coroner", "autopsy report"],  // nouns/names that should pull this event into context when the story touches them
  "scheduledBeat": {"afterInWorld": "Oct 5, 1998", "description": "The falsified autopsy report reaches the Council."},  // OPTIONAL future consequence, or null
  "supersedesEntryId": null,                       // set to a ledger id ONLY when this event REPLACES/UPDATES that prior offscreen fact
  "driveEffects": [{"character": "Wilkins", "wantText": "silence the coroner", "effect": "satisfied", "note": "coroner bribed"}]  // which sheet wants this event satisfied/advanced — REQUIRED whenever the event completes or moves a listed want
}

HARD RULES:
0. THE OFFSCREEN LEDGER IS CANON. Everything in <offscreen_ledger_already_happened> HAS HAPPENED — never re-simulate, repeat, restate, or regress a ledger event (if Wanda already disclosed the secret, she cannot disclose it again or be "about to"). To move a ledger fact forward, either propose a genuinely NEW next development, or set supersedesEntryId to replace the old entry with the updated state. When a want has already been satisfied offscreen (see the ledger), do not generate it again.
1. Ground every event in the provided drive sheets / threads / recent events. NO new named characters unless a sheet or thread implies them (minor unnamed functionaries like "a courier" are fine).
2. Do not contradict established canon. Do not resolve or hijack an active story thread the player is driving — offscreen events set tables, they do not eat the meal.
3. Advance different characters' agendas in DIFFERENT events — no omnibus events.
4. Scale to the window — <window_scale> is authoritative: a TINY window (minutes) fits at most 1-2 modest continuations or NOTHING (an empty events array is a good answer); hours → small moves; days → real developments; weeks → arc-level developments. Never emit day-scale events for a minutes-scale window.
5. Do NOT write anything the player's character does — the player owns them.
6. If <gm_guidance> is present it is the GM's authoritative framing for this window — what the player's character is occupied with, or why time passes. Every event MUST be consistent with it (an unconscious or absent PC cannot be met, contacted, or fought), and events should build on the situation it describes — but you still never author the player's own actions beyond what the guidance itself states.
7. Events listed in <scheduled_beats_play_on_screen> are scheduled to happen on screen when the story reaches their time. Do not narrate them, their outcome, or anything that assumes they already happened.
8. Output ONLY JSON: {"events":[ ... ]}. No prose, no fences.`;

const CANON_CHECK_SYSTEM = `You are the CANON CHECKER for a roleplay campaign. You receive PROPOSED offscreen events plus canon extracts (character sheets, active threads, recent established events). For each proposed event, verify:
1. It does not contradict the canon extracts.
2. Its actors behave consistently with their drive sheets (wants/red lines).
3. It does not resolve, spoil, or hijack an active player-driven thread.
4. Its knownBy list is plausible (nobody knows it who couldn't).
5. When <gm_guidance> is provided, the event is consistent with it (e.g. nothing interacts with a PC the guidance marks unconscious or away).
6. It does NOT re-simulate, repeat, or regress anything in <offscreen_ledger_already_happened> (those events already happened and are canon). An event that restates a ledger fact without supersedesEntryId, or that puts a character BEFORE a state the ledger says they already reached, must be rejected.
7. Its scale fits <window_scale> — reject day-scale events proposed for a minutes-scale window.
8. It does not narrate, resolve, or assume an event listed in <scheduled_beats_play_on_screen>. Those happen on screen when the story reaches their time; an offscreen event that tells them must be rejected.

Output ONLY JSON: {"verdicts":[{"index":0,"ok":true},{"index":1,"ok":false,"reason":"contradicts X"}]} — one verdict per proposed event, by index.`;

interface TickDetails {
  workerEffort?: string;
  openaiFastMode?: boolean;
  mode: "catchup" | "skip";
  fromInWorld: string | null;
  toInWorld: string;
  guidance?: string | null;
  worldTickModel: string;
  autoApply: boolean;
  embeddingModel: string;
  automatic?: boolean;
  dramatistEnabled?: boolean;
  dramatistModel?: string;
  dramatistIntensity?: "restrained" | "standard" | "bold";
  rollingDiffOrdinal?: number;
  cadence?: number;
  expectedWorldClockJson?: string | null;
  transcriptInput?: PipelineTranscriptManifest;
  neutralChecked?: boolean;
  proposed?: ProposedWorldEvent[];
  dropped?: Array<{ summary: string; reason: string }>;
  appliedAt?: string | null;
  appliedCount?: number | null;
  appliedEntryIds?: string[];
  dramatist?: DramatistPassDetails | null;
  clocks?: { created: number; filled: Array<{ id: string; name: string; ownerCharacter: string | null }>; active: number };
}

export class WorldTickWorker {
  private readonly logger = createLogger("world-tick-worker");
  private readonly runs;
  private readonly campaigns;
  private readonly lorebook;
  private readonly drives;
  private readonly beats;
  private readonly messages;
  private readonly sessions;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly adversarialWorld;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;
  private readonly dramatistRoll;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults; dramatistRoll?: number }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.runs = new PipelineRunRepository(db);
    this.campaigns = new CampaignRepository(db);
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.drives = new CharacterDrivesRepository(db);
    this.beats = new ScheduledBeatRepository(db);
    this.messages = new MessageRepository(db);
    this.sessions = new SessionRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.adversarialWorld = new AdversarialWorldRepository(db);
    this.runtime = options?.runtime ?? null;
    this.dramatistRoll = options?.dramatistRoll;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    const providers = buildEmbeddingProviders(this.runtimeDefaults);
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const startedAt = new Date().toISOString();
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, startedAt, "campaign not found", null); return; }
      const parsedDetails = run.detailsJson ? JSON.parse(run.detailsJson) as TickDetails : null;
      if (!parsedDetails?.toInWorld) { this.runs.markFailed(run.id, startedAt, "tick window missing", run.detailsJson ?? null); return; }
      const details: TickDetails = { ...parsedDetails };
      details.transcriptInput = inputs.manifest;
      if (details.expectedWorldClockJson === undefined) details.expectedWorldClockJson = campaign.worldClockJson;
      const storyMessages = run.sessionId ? inputs.readSession(run.sessionId) : [];
      const session = run.sessionId ? this.sessions.findById(run.userId, run.sessionId) : null;
      // Session-only (0077) — the campaign settings tier is retired.
      const resolvedSettings = contextSettingsSchema.parse(safeJsonObject(session?.contextOverridesJson ?? null));
      if (details.automatic && details.toInWorld === "story-now") {
        const clock = parseWorldClock(campaign.worldClockJson);
        const storyNow = latestSceneDate(storyMessages, clock?.simulatedThroughEpoch ?? null);
        if (!storyNow?.label && !clock?.simulatedThrough) {
          recordSystemEvent({
            userId: run.userId, source: "world_tick", severity: "warn", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
            message: "automatic Dramatist tick could not resolve story-now from scene metadata — tick skipped rather than writing a guessed world date",
          });
          this.completeRun(run.id, new Date().toISOString(), "World tick skipped: no parseable story date", JSON.stringify({ ...details, proposed: [], dropped: [], appliedAt: null, dramatist: null }));
          return;
        }
        // Unparseable story-now against an ANCHORED clock: the scene parser
        // now returns a null epoch for relative/weekday-only labels ("two days later"), and
        // applyWorldEvents refuses to advance an anchored clock to a label
        // without an epoch (422). Skip visibly here instead of proposing a
        // window that cannot apply; never fall back to the clock label (that
        // would tick a zero-width window under a date the story never wrote).
        if (storyNow?.label && storyNow.epoch == null && clock?.simulatedThroughEpoch != null) {
          const skippedAt = new Date().toISOString();
          recordSystemEvent({
            userId: run.userId, source: "world_tick", severity: "info", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
            message: `automatic Dramatist tick skipped: the newest scene date "${storyNow.label}" is not a calendar date (the world clock is simulated through ${clock.simulatedThrough}) — put a month/day date in the scene block or edit the scene date; the Dramatist resumes on the first cadence tick with a parseable date`,
            details: { runId: run.id, storyNow: storyNow.label, worldClock: clock.simulatedThrough },
          });
          this.completeRun(run.id, skippedAt, `World tick skipped: story date "${storyNow.label}" is not a calendar date — nothing to simulate against the clock (${clock.simulatedThrough})`,
            JSON.stringify({ ...details, fromInWorld: clock.simulatedThrough, toInWorld: storyNow.label, skipped: "story-date-unparseable", proposed: [], dropped: [], appliedAt: null, dramatist: null }));
          return;
        }
        // Story-now BEHIND the watermark: after a manual
        // "Skip forward" the clock sits ahead of the scene headers until the
        // composer adopts the new date. The old code built a backward window
        // (clock → story-now), spent two model calls on it, and then
        // applyWorldEvents rejected it with the "clock changed" CAS message
        // (the clock's CAS guard doing its job) — every cadence tick failed the same
        // way and the Dramatist stayed silent for the whole stretch. Skip
        // visibly instead: nothing to simulate until the story passes the clock.
        if (storyNow?.epoch != null && clock?.simulatedThroughEpoch != null && storyNow.epoch < clock.simulatedThroughEpoch) {
          const skippedAt = new Date().toISOString();
          recordSystemEvent({
            userId: run.userId, source: "world_tick", severity: "info", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
            message: `automatic Dramatist tick skipped: the story (${storyNow.label}) has not yet reached the simulated world clock (${clock.simulatedThrough}) — play forward or edit the scene date; the Dramatist resumes on the first cadence tick after the story passes the clock`,
            details: { runId: run.id, storyNow: storyNow.label, worldClock: clock.simulatedThrough },
          });
          this.completeRun(run.id, skippedAt, `World tick skipped: story-now (${storyNow.label}) is behind the world clock (${clock.simulatedThrough}) — nothing to simulate yet`,
            JSON.stringify({ ...details, fromInWorld: clock.simulatedThrough, toInWorld: storyNow.label, skipped: "story-behind-clock", proposed: [], dropped: [], appliedAt: null, dramatist: null }));
          return;
        }
        details.toInWorld = storyNow?.label ?? clock!.simulatedThrough;
        details.fromInWorld = details.fromInWorld ?? clock?.simulatedThrough ?? null;
      }

      // Freeze automatic input identities before the first model await. A
      // resumed proposal must retain the manifest that produced its checkpoint.
      if (inputs.source) this.lorebook.transact(() => {
        assertSource();
        this.runs.updateRun(run.id, { detailsJson: JSON.stringify(details), updatedAt: new Date().toISOString() });
      });

      // World inputs: every drive sheet with substance, the thread index, recent
      // established events, and the campaign prompt head for tone.
      const allSheets = this.drives.listForCampaign(run.campaignId);
      const playerKeys = new Set(resolvedSettings.playerCharacterKeys.map((key) => key.trim().toLocaleLowerCase()).filter(Boolean));
      const sheets = allSheets
        .filter((d) => !d.sealed)
        .filter((d) => !playerKeys.has(d.characterName.trim().toLocaleLowerCase()))
        .filter((d) => d.sheet.wants.length > 0 || d.sheet.goals.length > 0 || d.sheet.offpageProject)
        .slice(0, 20);
      if (allSheets.length === 0) {
        this.runs.markFailed(run.id, new Date().toISOString(), "no drive sheets with active goals — seed sheets before ticking the world", run.detailsJson ?? null);
        return;
      }
      // The constant index by name. The old lookup took the five
      // newest `threads` rows and looked for the index among them; the tracker
      // commits the index and every thread it rewrote with one timestamp, so
      // after a run that changed five or more threads SQLite's tie order decided
      // whether the tick (and the Dramatist's inventory) saw any threads at all.
      const threadIndexEntry = this.lorebook.findThreadIndex(run.userId, run.campaignId) ?? null;
      const threadIndex = threadIndexEntry?.content ?? "(no thread tracker)";
      const recentEvents = this.lorebook.listForCampaign(run.userId, run.campaignId, { tag: "events", limit: 25, sort: "updated_at", order: "desc" })
        .filter((e) => !isProvisionalMarker(parseOffscreenMarker(e.comment))) // provisional lives in the ledger block, complete — not a recency lottery
        .slice(0, 15)
        .map((e) => `- ${e.name}: ${truncate(e.content, 240)}`).join("\n") || "(none)";
      // Offscreen ledger (offscreen-flow 2026-07-17): EVERYTHING that already
      // happened behind the scenes, complete and newest-first — the proposer
      // advances or supersedes it, never re-simulates it.
      const offscreenActive = listActiveOffscreen(this.lorebook, run.userId, run.campaignId);
      const offscreenLedger = offscreenActive.length > 0 ? renderOffscreenLedger(offscreenActive).block : "(nothing has happened offscreen yet)";
      const ledgerIds = new Set(offscreenActive.map((e) => e.id));
      const promptHead = truncate(campaign.systemPrompt, 1200);

      const sheetsBlock = sheets.map((d) => `### ${d.characterName}\n${JSON.stringify({
        wants: d.sheet.wants.map((w) => w.text), goals: d.sheet.goals.filter((g) => g.status === "active").map((g) => g.text),
        offpageProject: d.sheet.offpageProject, redLines: d.sheet.redLines, leverage: d.sheet.leverage,
        dispositions: d.sheet.dispositions,
      })}`).join("\n\n") || "(no unsealed NPC sheets; sealed schemes are handled only by the Dramatist pass)";
      const windowLabel = details.fromInWorld ? `${details.fromInWorld} → ${details.toInWorld}` : `up to ${details.toInWorld}`;
      // Window scale (offscreen-flow): auto catchup ticks often cover MINUTES of
      // story time; day-scale events for those windows were the volume bug.
      // Year anchors: a year-less window label ("Oct 5") anchors to
      // the campaign's clock position, and the window end to its start —
      // without them V8 parsed "Oct 5" as 2001 and a 1998 campaign's window
      // computed as years wide (LARGE scale for a minutes-long catchup).
      const clockAnchor = parseWorldClock(campaign.worldClockJson)?.simulatedThroughEpoch ?? null;
      const fromEpoch = parseInWorldDate(details.fromInWorld ?? "", clockAnchor);
      const toEpoch = parseInWorldDate(details.toInWorld, fromEpoch ?? clockAnchor);
      const windowHours = fromEpoch != null && toEpoch != null && toEpoch > fromEpoch ? (toEpoch - fromEpoch) / 3_600_000 : null;
      const windowScale = windowHours == null ? "UNKNOWN (no parseable dates — use judgment, prefer small)"
        : windowHours < 2 ? `TINY (~${Math.max(1, Math.round(windowHours * 60))} minutes) — at most 1-2 modest continuations, or NO events`
        : windowHours < 24 ? `SMALL (~${Math.round(windowHours)} hours) — small moves only`
        : windowHours < 168 ? `MEDIUM (~${Math.round(windowHours / 24)} days) — real developments fit`
        : `LARGE (~${Math.round(windowHours / 168)} weeks) — arc-level developments fit`;

      // Pending beats the story will play on screen by the window's end:
      // a time skip across a dated beat let the neutral pass
      // narrate it offscreen in its own words (2026-09-09, two messages
      // apart), and the beat then fired on top of its own retelling. They are
      // named to the proposer and the checker as off limits. Sealed beats stay
      // out (hidden until they fire; the neutral pass never sees sealed
      // material), and so do beats dated after the window.
      const onScreenBeats = this.beats.listForCampaign(run.campaignId, "pending")
        .filter((beat) => !beat.sealed && (beat.afterEpoch == null ? !beat.afterInworld : toEpoch != null && beat.afterEpoch <= toEpoch))
        .slice(0, MAX_ON_SCREEN_BEATS);
      const onScreenBlock = onScreenBeats.length > 0
        ? `\n\n<scheduled_beats_play_on_screen>\n${onScreenBeats.map((beat) => `- ${beat.afterInworld ? `(${beat.afterInworld}) ` : ""}${truncate(beat.description, 300)}`).join("\n")}\n</scheduled_beats_play_on_screen>`
        : "";
      // A scheme step's not-before date that does not read as a calendar date
      // holds the step, and any beat a clock arms for it, until it is fixed
      // say so each tick rather than let the scheme stall silently.
      // The message names no character; the details carry who, for Behind the
      // Curtain.
      const unreadableStepDates = allSheets.filter((record) => record.sealed && record.scheme).flatMap((record) => {
        const step = record.scheme!.steps[record.scheme!.currentStep];
        const label = step?.notBefore?.trim();
        return label && parseInWorldDate(label, toEpoch ?? clockAnchor) == null ? [{ actor: record.characterName, step: record.scheme!.currentStep + 1, notBefore: label }] : [];
      });
      if (unreadableStepDates.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "world_tick", severity: "warn", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
          message: `${unreadableStepDates.length} sealed scheme step(s) carry a not-before date that does not read as a calendar date (${unreadableStepDates.map((d) => `"${d.notBefore}"`).join(", ")}); each waits, with any beat armed for it, until its date is a month and day (optionally a year and a time or part of the day)`,
          details: { runId: run.id, steps: unreadableStepDates },
        });
      }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, startedAt, "no chat runtime available", run.detailsJson ?? null); return; }
      // Both dials resolve loudly, as every other worker's do: a dial that no
      // longer resolves for the account fails
      // the run with the dial named and a warn event, never runs the raw id.
      // The Dramatist's dial resolves here too, before the first model call, so
      // a bad dial costs no neutral-pass calls and applies nothing.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "world_tick", "world tick", details.worldTickModel, getConfiguredDefaultModelId() ?? DEFAULT_TICK_MODEL);
      const dramatistWanted = !details.dramatist && (details.dramatistEnabled ?? resolvedSettings.dramatistEnabled);
      const dramatistModelId = dramatistWanted
        ? resolveWorkerModel(this.customEndpoints, run, "world_tick", "Dramatist", details.dramatistModel ?? resolvedSettings.dramatistModel, getConfiguredDefaultModelId() ?? DEFAULT_TICK_MODEL)
        : null;
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      const guidanceBlock = details.guidance?.trim() ? `\n\n<gm_guidance>\n${details.guidance.trim()}\n</gm_guidance>` : "";
      const proposeUser = `<window>${windowLabel}</window>\n<window_scale>${windowScale}</window_scale>${guidanceBlock}\n\n<campaign_tone>\n${promptHead}\n</campaign_tone>\n\n<drive_sheets>\n${sheetsBlock}\n</drive_sheets>\n\n<active_threads_do_not_resolve>\n${truncate(threadIndex, 1600)}\n</active_threads_do_not_resolve>\n\n<offscreen_ledger_already_happened>\n${offscreenLedger}\n</offscreen_ledger_already_happened>\n\n<recent_established_events>\n${recentEvents}\n</recent_established_events>${onScreenBlock}`;

      const proposed: ProposedWorldEvent[] = [];
      let kept: ProposedWorldEvent[] = details.proposed ?? [];
      let dropped: Array<{ summary: string; reason: string }> = details.dropped ?? [];
      let fullyChecked = details.neutralChecked ?? true;
      if (sheets.length > 0 && details.neutralChecked === undefined) {
        // Pass 1: neutral offscreen ADVANCE proposal. Sealed schemes never enter
        // this prompt; they have one writer, the Dramatist scheme path.
        let proposeText = "";
        this.runs.heartbeat(run.id);
        await withDeadline(WORKER_LLM_DEADLINE_MS, "world_tick propose call", (dl) => withRetry(() => runtime.streamChat({
          modelId, systemPrompt: PROPOSE_SYSTEM,
          messages: [{ role: "user", content: proposeUser, attachments: [] }],
          temperature: 0, thinkingMode: workerThinkingModeFor(modelId, workerEffort), thinkingBudget: null, effort: workerEffort, cacheTtl: "off", speed,
          requestId: `world-tick-${run.id}-propose`, signal: dl,
        }, { onStart: () => {}, onDelta: (d) => { proposeText += d; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { proposeText = ""; }, signal), signal);

        const rawEvents = parseFirstJson<{ events?: unknown[] }>(proposeText, "{")?.events;
        let proposalValid = Array.isArray(rawEvents);
        for (const raw of Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_EVENTS) : []) {
          const parsed = proposedWorldEventSchema.safeParse(raw);
          if (!parsed.success) { proposalValid = false; continue; }
          // A supersede target must be a real ledger id — a hallucinated id
          // must not silently disable nothing (or worse, something else).
          if (parsed.data.supersedesEntryId && !ledgerIds.has(parsed.data.supersedesEntryId)) parsed.data.supersedesEntryId = null;
          proposed.push(parsed.data);
        }
        if (!proposalValid) {
          fullyChecked = false;
          recordSystemEvent({
            userId: run.userId, source: "world_tick", severity: "warn", campaignId: run.campaignId,
            message: "neutral world simulation returned invalid events — auto-apply skipped; continuing to the Dramatist pass",
            details: { head: proposeText.slice(0, 300) },
          });
        }
        if (proposed.length > 0) {
          // Pass 2: adversarial canon check — drop contradictions with reasons.
          const checkUser = `<proposed_events>\n${proposed.map((e, i) => `${i}: ${JSON.stringify(e)}`).join("\n")}\n</proposed_events>${guidanceBlock}\n<window_scale>${windowScale}</window_scale>\n\n<canon_drive_sheets>\n${sheetsBlock}\n</canon_drive_sheets>\n\n<canon_threads>\n${truncate(threadIndex, 1600)}\n</canon_threads>\n\n<offscreen_ledger_already_happened>\n${offscreenLedger}\n</offscreen_ledger_already_happened>\n\n<canon_recent_events>\n${recentEvents}\n</canon_recent_events>${onScreenBlock}`;
          let checkText = "";
          this.runs.heartbeat(run.id);
          await withDeadline(WORKER_LLM_DEADLINE_MS, "world_tick canon-check call", (dl) => withRetry(() => runtime.streamChat({
            modelId, systemPrompt: CANON_CHECK_SYSTEM,
            messages: [{ role: "user", content: checkUser, attachments: [] }],
            temperature: 0, thinkingMode: workerThinkingModeFor(modelId, workerEffort), thinkingBudget: null, effort: workerEffort, cacheTtl: "off", speed,
            requestId: `world-tick-${run.id}-check`, signal: dl,
          }, { onStart: () => {}, onDelta: (d) => { checkText += d; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { checkText = ""; }, signal), signal);

          const verdicts = parseFirstJson<{ verdicts?: Array<{ index?: number; ok?: boolean; reason?: string }> }>(checkText, "{")?.verdicts ?? [];
          const verdictSeen = new Set<number>();
          const rejected = new Map<number, string>();
          for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
            if (!Number.isInteger(verdict?.index) || verdict.index! < 0 || verdict.index! >= proposed.length) { fullyChecked = false; continue; }
            const index = verdict.index!;
            if (verdictSeen.has(index) || typeof verdict.ok !== "boolean") fullyChecked = false;
            verdictSeen.add(index);
            if (verdict.ok === false) rejected.set(index, String(verdict.reason ?? "canon conflict"));
          }
          fullyChecked = fullyChecked && proposed.every((_, index) => verdictSeen.has(index));
          if (!fullyChecked) {
            recordSystemEvent({
              userId: run.userId, source: "world_tick", severity: "warn", campaignId: run.campaignId,
              message: `canon check returned no/partial verdicts (${verdictSeen.size}/${proposed.length}) — events kept for manual review${details.autoApply ? "; auto-apply skipped" : ""}`,
              details: { head: checkText.slice(0, 300) },
            });
          }
          kept = proposed.filter((_, index) => !rejected.has(index));
          dropped = proposed.map((event, index) => rejected.has(index) ? { summary: event.summary, reason: rejected.get(index)! } : null)
            .filter((value): value is { summary: string; reason: string } => value !== null);
        }
      }

      const doneDetails: TickDetails & {
        proposed: ProposedWorldEvent[];
        dropped: Array<{ summary: string; reason: string }>;
        appliedAt: string | null;
        appliedCount: number | null;
        dramatist: DramatistPassDetails | null;
        clocks?: {
          created: number;
          filled: Array<{ id: string; name: string; ownerCharacter: string | null }>;
          active: number;
        };
      } = { ...details, proposed: kept, dropped, neutralChecked: fullyChecked, appliedAt: details.appliedAt ?? null, appliedCount: details.appliedCount ?? null, dramatist: details.dramatist ?? null };
      const persistStage = () => {
        assertSource();
        if (signal?.aborted || this.runs.findById(run.userId, run.id)?.status === "canceled") throw new DOMException("tick canceled", "AbortError");
        this.runs.updateRun(run.id, { detailsJson: JSON.stringify(doneDetails), updatedAt: new Date().toISOString() });
      };
      persistStage();

      if (details.autoApply && fullyChecked && !doneDetails.appliedAt) {
        // Canon and the stage marker commit together. A recovered run resumes
        // past this stage even if a later model call fails or the process dies.
        await applyWorldEvents(
          { lorebook: this.lorebook, beats: this.beats, campaigns: this.campaigns, embedding: this.embedding, drives: this.drives, adversarialWorld: this.adversarialWorld },
          {
            userId: run.userId, campaignId: run.campaignId, tickRunId: run.id, events: kept, windowFrom: details.fromInWorld, windowTo: details.toInWorld, embedModelId: details.embeddingModel,
            expectedWorldClockJson: details.expectedWorldClockJson,
            onApplied: (r) => { doneDetails.appliedAt = new Date().toISOString(); doneDetails.appliedCount = r.created; doneDetails.appliedEntryIds = r.entryIds; persistStage(); },
          },
        );
      }

      if (!doneDetails.dramatist && dramatistModelId) {
        doneDetails.dramatist = await runDramatistPass(
          { campaigns: this.campaigns, drives: this.drives, lorebook: this.lorebook, beats: this.beats, runs: this.runs },
          {
            run, runtime, modelId: dramatistModelId,
            effort: workerEffortFor(dramatistModelId, details.workerEffort),
            speed: openaiFastModeFor(dramatistModelId, details.openaiFastMode),
            intensity: details.dramatistIntensity ?? resolvedSettings.dramatistIntensity,
            tickOrdinal: details.rollingDiffOrdinal ?? this.runs.countCompletedByKindAndCampaign("world_tick", run.campaignId) + 1,
            campaignStateJson: campaign.dramatistStateJson,
            playerCharacterKeys: resolvedSettings.playerCharacterKeys,
            threadIndexComment: threadIndexEntry?.comment ?? null,
            storyNow: details.toInWorld,
            storyNowEpoch: toEpoch,
            sceneSnapshot: latestSceneSnapshot(storyMessages),
            recentWindow: dramatistRecentWindow(storyMessages),
            canonContext: `<campaign_tone>${promptHead}</campaign_tone>\n<drive_sheets>${sheetsBlock}</drive_sheets>\n<threads>${truncate(threadIndex, 2400)}</threads>\n<offscreen_ledger_already_happened>${truncate(offscreenLedger, 4000)}</offscreen_ledger_already_happened>\n<recent_events>${recentEvents}</recent_events>`,
            signal, roll: this.dramatistRoll,
            onSettled: (result) => { doneDetails.dramatist = result; persistStage(); },
          },
        );
      }

      // Clocks advance on the tick, whether or not <user> engaged with them —
      // a threat that only progresses when looked at is not a threat, and that
      // property is the entire reason clocks exist instead of "remember to
      // escalate" sitting in a prompt. Standings decay on the same beat so a
      // grudge fades slowly rather than resetting on an apology. Both no-op below
      // stance 2.
      const stanceForClocks = resolvedSettings.worldStance ?? 1;
      // PRODUCER (phase 7). Until this existed, advanceClocks advanced an
      // always-empty table — nothing in the system ever called createClock, so
      // clocks were schema plus prose with no state behind them. A sealed
      // antagonist scheme IS a front with a countdown, so that is where clocks come
      // from; keyed on the owner so a tick never stacks duplicates.
      // Clock-retirement events are collected inside the transaction and
      // recorded after it: the worker records events on a different connection
      // than the one holding this (IMMEDIATE) write transaction.
      const retiredClocks: string[] = [];
      if (!doneDetails.clocks) this.lorebook.transact(() => {
        const clocksCreated = this.ensureClocksForSchemes(run.campaignId, stanceForClocks, run.userId, retiredClocks);
        const filledClocks = this.adversarialWorld.advanceClocks(run.campaignId, stanceForClocks, resolvedSettings.storytellerPacing ?? "steady", (details.rollingDiffOrdinal ?? this.runs.countCompletedByKindAndCampaign("world_tick", run.campaignId)));
        if (stanceForClocks >= 2) this.adversarialWorld.decayStandings(run.campaignId);
        if (filledClocks.length > 0) {
          this.logger.info({ campaignId: run.campaignId, filled: filledClocks.map((c) => c.name) }, "threat clocks filled — their beats are due");
          // A filled clock FORCES its beat. That is the whole difference between a
          // clock and a reminder, and this branch previously only logged — a clock
          // could fill and nothing at all happened.
          this.armBeatsForFilledClocks(run.campaignId, run.id, filledClocks, run.userId, retiredClocks, toEpoch);
        }
        doneDetails.clocks = {
          created: clocksCreated,
          filled: filledClocks.map((clock) => ({ id: clock.id, name: clock.name, ownerCharacter: clock.ownerCharacter })),
          active: this.adversarialWorld.listActiveClocks(run.campaignId).length,
        };
        persistStage();
      });
      for (const clockId of retiredClocks) this.recordRetiredClock(run.campaignId, clockId, run.userId);

      const doneAt = new Date().toISOString();
      const completed = this.completeRun(run.id, doneAt,
        `World tick (${windowLabel}): ${kept.length} neutral event(s)${dropped.length ? `, ${dropped.length} dropped by canon check` : ""}${doneDetails.appliedAt ? ", auto-applied" : details.autoApply && !fullyChecked ? " — auto-apply skipped (canon check incomplete); review to apply" : " — review to apply"}${doneDetails.dramatist ? `; Dramatist ${doneDetails.dramatist.outcome}` : ""}`,
        JSON.stringify(doneDetails));
      // A cancel that landed after the last stage marker: the stages
      // already committed stand (each one is revisioned and recorded in the
      // row's details); the row stays canceled and carries no approvedAt.
      const committedStages = [
        doneDetails.appliedAt ? "neutral events applied" : null,
        doneDetails.dramatist ? `Dramatist ${doneDetails.dramatist.outcome}` : null,
        doneDetails.clocks && (doneDetails.clocks.created > 0 || doneDetails.clocks.filled.length > 0) ? "threat clocks changed" : null,
      ].filter((stage): stage is string => stage !== null);
      if (!completed && committedStages.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "world_tick", severity: "info", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
          message: `world tick was canceled after its stages committed (${committedStages.join(", ")}); those changes stand and the run stays canceled`,
          details: { runId: run.id, committedStages },
        });
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "world tick failed", null);
    }
  }

  /** Guarded completion: `markCompleted` refuses a row that is no
   *  longer running (a cancel landed), and `approvedAt` is stamped only on a
   *  row that actually completed, as the rolling diff and the tracker do.
   *  `pipeline_runs.approved_at` has live consumers; a canceled row must not
   *  carry it. */
  private completeRun(runId: string, at: string, summary: string, detailsJson: string): boolean {
    const completed = this.runs.markCompleted(runId, at, summary, detailsJson);
    if (completed) this.runs.updateRun(runId, { approvedAt: at });
    return completed;
  }

  /**
   * Give every sealed antagonist scheme with steps LEFT a clock. Idempotent by
   * owner: a character who already has an active clock is skipped, so this can
   * run on every tick.
   *
   * A COMPLETED scheme (currentStep past the last index) spawns nothing. Without
   * that guard the step clamp below resurrects the final step of a finished
   * scheme forever: clock created → fills → fires its beat → resolved →
   * recreated next tick at [0/N] — the 07-29..31 loop that re-fired the same
   * escalations up to six times each inside 27 in-world minutes. The dramatist's
   * inventory already treats currentStep past the end as "no step" (its unclamped
   * read returns undefined); this path must agree with it.
   *
   * The scheme's current step becomes the clock's impulse, which is what keeps an
   * offscreen antagonist acting in character between appearances rather than idling
   * until the plot needs them.
   */
  private ensureClocksForSchemes(campaignId: string, worldStance: number, userId?: string, retiredSink?: string[]): number {
    if (worldStance < 2) return 0;
    for (const clock of this.adversarialWorld.listActiveClocks(campaignId)) {
      if (!clock.ownerCharacter) continue;
      const scheme = this.drives.findByCharacter(campaignId, clock.ownerCharacter)?.scheme;
      const step = scheme?.steps[scheme.currentStep];
      // Legacy clocks have no provable step identity. Rebuild their countdown
      // once rather than infer a step from potentially repeated/edited prose.
      if (!scheme || !step || clock.schemeStepKey !== schemeStepKey(scheme)) {
        this.retireStaleSchemeClock(campaignId, clock.id, userId, retiredSink);
      }
    }
    const existing = new Set(
      this.adversarialWorld.listActiveClocks(campaignId)
        .map((clock) => (clock.ownerCharacter ?? "").trim().toLocaleLowerCase())
        .filter(Boolean),
    );
    let created = 0;
    for (const record of this.drives.listForCampaign(campaignId)) {
      if (!record.sealed || !record.scheme) continue;
      const owner = record.characterName.trim();
      if (!owner || existing.has(owner.toLocaleLowerCase())) continue;
      const scheme = record.scheme;
      if (scheme.steps.length === 0 || scheme.currentStep >= scheme.steps.length) continue;
      const step = scheme.steps[Math.min(scheme.currentStep, Math.max(0, scheme.steps.length - 1))];
      const impulse = step?.text?.trim() || `advance the scheme against ${scheme.targetCitation}`;
      this.adversarialWorld.createClock({
        campaignId,
        name: `${owner} — ${scheme.targetCitation}`.slice(0, 200),
        impulse,
        // Cadence is how often the scheme wants to move, so a patient scheme gets a
        // longer clock. Clamped inside createClock.
        total: Math.max(2, Math.min(12, scheme.cadence || 6)),
        ownerCharacter: owner,
        schemeStepKey: schemeStepKey(scheme),
      });
      existing.add(owner.toLocaleLowerCase());
      created += 1;
    }
    if (created > 0) this.logger.info({ campaignId, created }, "threat clocks created from sealed schemes");
    return created;
  }

  /**
   * A filled clock becomes a pending beat and the clock is retired.
   *
   * The beat is the step's declared consequence when the step has one:
   * `armsBeat`'s description, class, severity and timing, the
   * same beat the Dramatist's offscreen advance arms for the step, so the two
   * producers dedupe against each other. Only a step without `armsBeat` falls
   * back to the step text, as a severity-2 `when_due` complication (a front that
   * has run its course is a real development, but it should not hijack the scene
   * on screen). Arming the step text itself put the antagonist's own move ("Ryn:
   * … strangle her") into the composer as the event to play: on 2026-09-09 one
   * tick armed two antagonists' raw steps at once and the composer invented a
   * character's capture.
   *
   * A step's `notBefore` date carries onto the beat as its `after_inworld` /
   * `after_epoch` (read against the tick's story-now, nearest year), so the beat
   * waits for its date; a date that does not read as a calendar date leaves the
   * beat held (a dated beat with no epoch is never due) and the tick names it.
   */
  private armBeatsForFilledClocks(
    campaignId: string,
    tickRunId: string,
    clocks: Array<{ id: string; name: string; impulse: string; ownerCharacter: string | null; schemeStepKey?: string | null }>,
    userId?: string,
    retiredSink?: string[],
    storyNowEpoch?: number | null,
  ): void {
    const now = new Date().toISOString();
    let armed = 0;
    let deduped = 0;
    for (const clock of clocks) {
      let step: AntagonistScheme["steps"][number] | undefined;
      let owner: string | null = null;
      if (clock.ownerCharacter) {
        const record = this.drives.findByCharacter(campaignId, clock.ownerCharacter);
        const scheme = record?.scheme;
        step = scheme?.steps[scheme.currentStep];
        if (!scheme || !step || clock.schemeStepKey !== schemeStepKey(scheme)) {
          this.retireStaleSchemeClock(campaignId, clock.id, userId, retiredSink);
          continue;
        }
        owner = record!.characterName;
      }
      const who = clock.ownerCharacter ? `${clock.ownerCharacter}: ` : "";
      const declared = step?.armsBeat ?? null;
      const notBefore = step?.notBefore?.trim() || null;
      // createIfNovel, not create: a clock impulse is re-derived from scheme
      // state, so an identical description is the same development coming around
      // again, never a new one. The backstop even if a future producer
      // reintroduces a recreate path.
      const wasNovel = this.beats.createIfNovel({
        id: randomUUID(),
        campaignId,
        description: declared ? declared.description : `${who}${clock.impulse}`.slice(0, 1000),
        afterInworld: notBefore,
        afterEpoch: notBefore ? parseInWorldDate(notBefore, storyNowEpoch ?? null) : null,
        sourceEventEntryId: null,
        sourceTickRunId: tickRunId,
        class: declared?.class ?? "complication",
        severity: declared?.severity ?? 2,
        timing: declared?.timing ?? "when_due",
        citationType: declared && owner ? "scheme" : "none",
        citationId: declared && owner ? owner : null,
        sealed: 1,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      if (wasNovel) armed += 1; else deduped += 1;
      // The fire IS the scheme's current step happening, so the step advances and
      // the next clock (if steps remain) runs the NEXT move — without this, the
      // recreated clock repeats the same step verbatim. The dramatist's ADVANCE
      // path can also move the step; both represent real progress, and the
      // completed-scheme guard in ensureClocksForSchemes terminates either way.
      if (clock.ownerCharacter) this.advanceSchemeStepForOwner(campaignId, clock.ownerCharacter, tickRunId, userId);
      // Retire it so the next tick does not re-arm the same beat forever.
      this.adversarialWorld.resolveClock(clock.id, "resolved");
    }
    this.logger.info({ campaignId, armed, deduped }, "armed beats from filled clocks");
  }

  /** `retiredSink`: when called inside the clocks transaction the event is
   *  deferred to the caller (recorded after commit — the worker's event
   *  connection is not the transaction's); direct callers record at once. */
  private retireStaleSchemeClock(campaignId: string, clockId: string, userId?: string, retiredSink?: string[]): void {
    this.adversarialWorld.resolveClock(clockId, "abandoned");
    this.logger.warn({ campaignId, clockId }, "retired a clock without the current scheme-step identity");
    if (retiredSink) retiredSink.push(clockId);
    else this.recordRetiredClock(campaignId, clockId, userId);
  }

  private recordRetiredClock(campaignId: string, clockId: string, userId?: string): void {
    if (userId) recordSystemEvent({
      userId, campaignId, source: "world_tick", severity: "info",
      message: "A scheme countdown was retired because its original step changed or could not be verified; the current step receives a new countdown.",
      details: { clockId },
    });
  }

  /** A fired clock consumed its scheme step. Mirrors the dramatist's advance
   *  write (same upsert shape, no history row) AND writes the same sealed
   *  advance note (it used to skip the note, so Behind the Curtain's
   *  sealed trail showed Dramatist advances only), so the two producers stay
   *  interchangeable in what they do to the scheme. The note needs the owner
   *  (`userId`); a caller without one (direct tests) advances without it. */
  private advanceSchemeStepForOwner(campaignId: string, owner: string, tickRunId: string, userId?: string): void {
    const record = this.drives.findByCharacter(campaignId, owner);
    const scheme = record?.scheme;
    if (!record || !scheme || scheme.steps.length === 0 || scheme.currentStep >= scheme.steps.length) return;
    const step = scheme.steps[scheme.currentStep]!;
    const toStep = Math.min(scheme.steps.length, scheme.currentStep + 1);
    this.drives.upsert({
      campaignId: record.campaignId, characterName: record.characterName, sheet: record.sheet,
      turn: record.lastUpdatedTurn, messageId: record.lastUpdatedMessageId, source: "dramatist",
      sealed: true, scheme: { ...scheme, currentStep: toStep },
      reason: `threat clock fired (tick ${tickRunId})`, recordHistory: false,
    });
    if (userId) writeSealedSchemeAdvanceNote(this.lorebook, {
      userId, campaignId, runId: tickRunId, characterName: record.characterName,
      stepText: step.text, fromStep: scheme.currentStep, toStep, stepCount: scheme.steps.length, targetCitation: scheme.targetCitation,
      reason: "threat clock fired",
    });
  }
}

function truncate(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max) + "…"; }

function safeJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** The Dramatist's recent window: the newest twelve
 *  messages with in-character text, each cut at 500 characters. [OOC: …]
 *  blocks are stripped first (a beat sheet is direction
 *  for the composer, never an event the Dramatist may build a beat on), and a
 *  message that was nothing but OOC does not take a slot. Exported for tests. */
export function dramatistRecentWindow(messages: Array<{ role: string; content: string }>): string {
  const lines: string[] = [];
  for (let index = messages.length - 1; index >= 0 && lines.length < 12; index -= 1) {
    const message = messages[index]!;
    const text = stripOocBlocks(message.content).trim();
    if (text) lines.unshift(`${message.role}: ${truncate(text, 500)}`);
  }
  return lines.join("\n") || "(no recent transcript window)";
}

function latestSceneSnapshot(messages: Array<{ role: string; sceneData?: string | null }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.sceneData) continue;
    try {
      const scene: unknown = JSON.parse(message.sceneData);
      if (scene && typeof scene === "object") return JSON.stringify(scene);
    } catch { /* use the safe fallback below */ }
  }
  return "(no structured scene snapshot; decline any beat that requires a guessed scene fit)";
}
