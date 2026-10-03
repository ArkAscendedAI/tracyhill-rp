import { pipelineInputsForRun } from "./settledSourceGuard";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";
import { STALE_WANT_PRESSURE, driveSheetSchema, type DriveSheet } from "@tracyhill-rp/contracts";

import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { CharacterDrivesRepository } from "../../../api/src/domain/chat/characterDrivesRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { sanitizeCharacterName } from "../../../api/src/domain/chat/sceneParser";
import { stripOocBlocks } from "../../../api/src/domain/context/stripOoc";
import { characterNameKey, resolveSheetNames } from "../../../api/src/domain/chat/characterNames";
import { resolveWorkerModel } from "./workerModel";
import { workerTurnNumber } from "./turnOrdinal";

const RECENT_TURN_WINDOW = 14;
const DEFAULT_DRIVE_MODEL = "claude-sonnet-4-6-bridge";
const CANON_CHECK_MAX_CHARS = 6000;
// The whole index (2026-09-27): it used to be cut at 1,500 characters, so the worker never saw that a thread
// had closed: one character's detention stayed "live" to every sheet that read it. A compacted index is ~8–10k chars.
export const THREAD_INDEX_PROMPT_CHARS = 12000;
export function threadIndexForPrompt(index: string): string { return truncate(index, THREAD_INDEX_PROMPT_CHARS); }
const CANON_CHECK_PER_WANT = 3;
const CANON_CHECK_SENTENCE_CHARS = 300;

const DRIVE_SYSTEM = `You maintain the DRIVE SHEETS for the NPCs of an ongoing roleplay campaign — the canonical record of what each character WANTS and how they pursue it. Drive sheets make NPCs autonomous: they act on their own interests instead of orbiting the player.

You are given each present character's CURRENT sheet and the most recent story turns. Output the COMPLETE updated sheet for EACH character as JSON — full re-emission, not a diff. (Lines like [GM SPOTLIGHT — Name] in the turns are author meta-directives, not story events — ignore them.)

ALTITUDE — READ CAREFULLY. Drive sheets track PERSONAL, near-term psychology: what this character is trying to get in the next scene or two, how they feel about others, what they conceal. They do NOT track campaign-level plot (quests, operations, mysteries) — that is the Thread Tracker's job, and you will be shown the thread index so you do NOT restate threads as wants. The index is also the record of what has concluded: a thread marked RESOLVED or ABANDONED is over (rule 8). A want is "get Corin alone before the Council meets", not "resolve the Council conspiracy".

CANON CHECK. For a character whose current sheet carries wants, concealments or an off-page project you may also be given <canon_check>: sentences from that character's own lorebook records and the campaign rules that mention the objects of those carried items, keyed by the want id (w…), the concealment's position on the current sheet (c1, c2…) or "offpage". They are settled canon and outrank both the recent turns and the current sheet. A want to re-ask a question the record shows answered, or to recover something the record says is gone, is not a want; a secret the record shows disclosed, untrue or about people who are gone is not a concealment (see rule 8).

For EACH present character output an object:
{
  "name": "Sofia",
  "wants": [ {"id":"w1","text":"get Corin alone before the Council meets","engaged": true, "blocked": false} ],  // near-term desires, max 5. id is stable — reuse it across runs. engaged=true iff THIS window's turns actively advanced or addressed the want. blocked=true iff the want cannot be pursued now because its object is out of the character's reach (the person is away, the thing is gone, the matter is in someone else's hands): it holds its pressure and the character does not act on it until it is reachable again — never invent a way to reach it.
  "goals": [ {"id":"g1","text":"reclaim her seat on the Council","status":"active"} ],  // arc-level aims, max 3. status: active|achieved|abandoned|blocked
  "redLines": ["never harm a child"],                 // hard behavioral limits, max 6
  "leverage": ["knows the coroner's gambling debt"],  // holds/resources they have, max 6
  "offpageProject": "quietly courting two Council votes",  // what they work on when off-page, or null
  "concealment": [ {"secret":"she ordered the ritual","behavior":"deflects to Council gossip; lies badly under direct pressure"} ],  // secrets + HOW they guard them, max 4
  "dispositions": { "Corin": "warming, but wary since the crypt", "Wilkins": "open contempt" }  // feelings toward others, qualitative (never numeric), max 6 entries
}

HARD RULES — violating them rejects your output:
1. FULL RE-EMISSION per character. Output the whole sheet, not a delta.
2. CARRY-FORWARD wants by id: a want from the current sheet either reappears (same id) or is intentionally dropped because it was ACHIEVED or ABANDONED given the recent turns. Do not silently churn ids.
3. SPECIFIC, ACTIONABLE wants grounded in the character and the recent turns — never filler like "wants to help" or "wants to survive". A want should be usable by a writer THIS scene.
4. STAY IN CHARACTER + IN CANON. Wants/dispositions must be consistent with who the character is; do not invent secrets the story hasn't supported.
5. CAPS: 5 wants, 3 goals, 6 red lines, 6 leverage, 4 concealments, 6 dispositions. Prefer the sharpest few over a long list. STRING LIMITS (overlong text gets truncated): want/goal text and concealment behavior ≤400 chars; red lines, leverage and concealment secrets ≤300; off-page project ≤600; disposition phrases ≤400. These are terse working notes, not prose.
6. QUALITATIVE dispositions only — a short phrase with a trend, never a number or score.
7. Output ONLY JSON: {"characters":[ ... ]}. No prose, no markdown fences. Include ONLY characters you were given; do not invent new ones.
8. SETTLED PREMISE. A carried want whose canon_check sentences show its object settled — gone, lost, destroyed, answered, delivered, dead, refused and accepted — is ABANDONED: drop it, or re-aim it at what is still genuinely open (a replacement, a grievance voiced once, a different goal). Never carry forward a want to re-ask an answered question or to recover what the record says is gone; the character may still feel the loss, and feelings belong in dispositions, not wants. The same test applies to a carried CONCEALMENT whose secret the record shows disclosed, no longer true, or about people or things that are gone (evacuated, delivered, dead, handed over) — drop it — and to an OFF-PAGE PROJECT whose object is settled — close it or re-aim it at what is still open. A guard for a secret that no longer exists is not a behavior the character has. A carried want that serves a thread the thread index shows RESOLVED or ABANDONED is abandoned too (a suspect's account is not wanted once his case is dismissed).`;

interface LlmWant { id: string; text: string; engaged?: boolean; blocked?: boolean }
export interface LlmCharacter {
  name: string;
  wants: LlmWant[];
  goals: DriveSheet["goals"];
  redLines: string[];
  leverage: string[];
  offpageProject: string | null;
  concealment: DriveSheet["concealment"];
  dispositions: Record<string, string>;
}

export class DriveUpdateWorker {
  private readonly runs;
  private readonly messages;
  private readonly campaigns;
  private readonly drives;
  private readonly lorebook;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.runs = new PipelineRunRepository(db);
    this.messages = new MessageRepository(db);
    this.campaigns = new CampaignRepository(db);
    this.drives = new CharacterDrivesRepository(db);
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
  }

  /** A present character's own lorebook records (core + satellites, named
   *  "<Name>" or "<Name> — …") plus the campaign's rules entries (owner rulings),
   *  enabled only — the material the canon check scans for each carried want. */
  private canonRecordsFor(userId: string, campaignId: string, names: string[]): Map<string, Array<{ name: string; content: string }>> {
    const out = new Map<string, Array<{ name: string; content: string }>>();
    let all: Array<{ name: string; content: string | null; tag: string | null }> = [];
    try { all = this.lorebook.listForCampaign(userId, campaignId, { isEnabled: true, limit: 5000 }); } catch { return out; }
    const rules = all.filter((e) => e.tag === "rules" && e.content).map((e) => ({ name: e.name, content: e.content ?? "" }));
    for (const name of names) {
      const own = all
        .filter((e) => e.content && isRecordOf(e.name, name))
        .map((e) => ({ name: e.name, content: e.content ?? "" }));
      out.set(name, [...own, ...rules]);
    }
    return out;
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const startedAt = new Date().toISOString();
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, startedAt, "campaign not found", null); return; }
      if (!run.sessionId) { this.runs.markCompleted(run.id, startedAt, "no session — drive update skipped", null); this.runs.updateRun(run.id, { approvedAt: startedAt }); return; }

      const allMessages = inputs.readSession(run.sessionId).filter(m => m.role !== "cold-start");
      // The engine's turn numbering: the settled read keeps only receipted
      // pairs, so counting it put `sinceTurn`, `lastUpdatedTurn` and the
      // prompt's current_turn behind the turn the agenda and the engine compare
      // them with. workerTurnNumber counts the engine's own population up to the
      // settling message; `allMessages` stays the source of the recent window.
      const turnNumber = workerTurnNumber(this.messages, run.userId, run.sessionId, inputs.source);
      const recentMsgs = allMessages.slice(-RECENT_TURN_WINDOW);

      // Present characters = everyone who appeared in the recent window's scenes.
      // PC exclusion arrives via detailsJson from the resolved SESSION settings
      // (0077). It used to read campaign contextDefaults — a scope the Engine panel
      // never writes — so it sat at its `[]` default and this guard never fired
      // once, letting the player's own protagonist accumulate a worker-maintained
      // drive sheet that was then injected every turn as an agenda to service.
      const runDetails = safeObject(run.detailsJson);
      const playerCharacterKeys = Array.isArray(runDetails.playerCharacterKeys)
        ? runDetails.playerCharacterKeys.map(String)
        : [];
      const pcSet = new Set(playerCharacterKeys.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean));
      const allSheets = this.drives.listForCampaign(run.campaignId);
      const sealed = new Set(allSheets.filter((row) => row.sealed).map((row) => characterNameKey(row.characterName)));
      const present = new Set<string>();
      for (const m of recentMsgs) {
        const scene = safeScene((m as { sceneData?: string | null }).sceneData);
        for (const raw of [...(scene?.present ?? []), ...(scene?.presentUnaware ?? [])]) {
          const name = sanitizeCharacterName(raw ?? "");
          if (!name || pcSet.has(name.toLocaleLowerCase()) || pcSet.has(characterNameKey(name)) || sealed.has(characterNameKey(name))) continue;
          present.add(name);
        }
      }
      if (present.size === 0) {
        this.runs.markCompleted(run.id, new Date().toISOString(), "no present characters in the recent window", JSON.stringify({ updated: 0 }));
        this.runs.updateRun(run.id, { approvedAt: new Date().toISOString() });
        return;
      }

      // One character, one sheet (2026-09-27): a scene's spelling resolves onto an existing sheet with the same
      // name key, and sheets that already share a key are reported for merging.
      const resolved = resolveSheetNames([...present], allSheets.map((row) => row.characterName));
      if (resolved.duplicates.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "drive_update", severity: "warn",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `duplicate drive sheets for one character: ${resolved.duplicates.map((g) => g.map((n) => `"${n}"`).join(" and ")).join("; ")} — keep one in the drives editor and delete the other`,
          details: { runId: run.id, duplicates: resolved.duplicates },
        });
      }
      const names = resolved.names;
      const existing = new Map(this.drives.findManyByCharacter(run.campaignId, names).map(r => [r.characterName, r]));
      // Settled-facts input (2026-09-26): the worker used to see only the sheet, the
      // recent window and the index, so a want whose premise canon had closed long
      // before the window (a lost bag, gone since Sept 9, asked after for a week)
      // was carried forward and its pressure climbed until the composer acted on it.
      const canonRecords = this.canonRecordsFor(run.userId, run.campaignId, names);
      const canonBlock = names.map((name) => {
        const sheet = existing.get(name)?.sheet;
        if (!sheet) return null;
        // Wants, concealments and the off-page project all carry forward by
        // re-emission and all went stale the same way (one NPC's "survivors below
        // decks" concealment carried four days past their evacuation, 2026-09-26).
        const items = carriedItems(sheet);
        if (items.length === 0) return null;
        const hits = canonCheckForWants(canonRecords.get(name) ?? [], items);
        if (hits.length === 0) return null;
        return `### ${name}\n${hits.map((h) => h.sentences.map((x) => `${h.id}: ${x}`).join("\n")).join("\n")}`;
      }).filter((x): x is string => Boolean(x)).join("\n\n");
      // Canon writer: OOC planning text is stripped (see stripOoc.ts).
      const recent = recentMsgs.map(m => `[${m.role}]: ${truncate(stripOocBlocks(m.content), 1800)}`).join("\n\n");
      // The constant index by name, never "the five newest threads
      // rows": the tracker stamps the index and every thread it rewrote with one
      // timestamp, so the old LIMIT 5 slice could miss it on a tie.
      const threadIndex = this.lorebook.findThreadIndex(run.userId, run.campaignId)?.content ?? "(no thread tracker yet)";

      const currentBlock = names.map(name => {
        const s = existing.get(name)?.sheet;
        return `### ${name}\n${s ? JSON.stringify(sheetToLlm(name, s)) : "(no sheet yet — establish one from the recent turns and this character's canon)"}`;
      }).join("\n\n");

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { driveModel?: string; workerEffort?: string; openaiFastMode?: boolean } : {};
      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, startedAt, "no chat runtime available", null); return; }
      // An unresolvable driveModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "drive_update", "drive update", details.driveModel, getConfiguredDefaultModelId() ?? DEFAULT_DRIVE_MODEL);
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      const userPrompt = `current_turn=${turnNumber}\n\n<thread_index>\n${threadIndexForPrompt(threadIndex)}\n</thread_index>\n\n<present_characters_current_sheets>\n${currentBlock}\n</present_characters_current_sheets>\n\n${canonBlock ? `<canon_check>\n${truncate(canonBlock, CANON_CHECK_MAX_CHARS)}\n</canon_check>\n\n` : ""}<recent_turns>\n${recent || "(none)"}\n</recent_turns>`;

      let accepted: LlmCharacter[] | null = null;
      let lastError = "";
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        let responseText = "";
        const sys = attempt === 0 ? DRIVE_SYSTEM : `${DRIVE_SYSTEM}\n\nYOUR PREVIOUS OUTPUT WAS REJECTED: ${lastError}\nFix it and re-emit the COMPLETE sheets.`;
        this.runs.heartbeat(run.id);
        await withDeadline(WORKER_LLM_DEADLINE_MS, "drive-update model call", (dl) => withRetry(() => runtime.streamChat({
          modelId, systemPrompt: sys,
          messages: [{ role: "user", content: userPrompt, attachments: [] }],
          temperature: 0, thinkingMode: workerThinkingModeFor(modelId, workerEffort), thinkingBudget: null, effort: workerEffort, cacheTtl: "off", speed,
          requestId: `drive-update-${run.id}-${attempt}`,
          signal: dl,
        }, { onStart: () => {}, onDelta: (d) => { responseText += d; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { responseText = ""; }, signal), signal);

        const parsed = parseCharacters(responseText, new Set(names));
        const verdict = parsed === null ? { ok: false as const, error: "invalid JSON characters array — re-emit the requested sheets" } : validate(parsed, existing);
        if (verdict.ok && parsed !== null) accepted = parsed;
        else if (!verdict.ok) lastError = verdict.error;
      }

      if (!accepted) {
        // Failure-safe: leave all sheets untouched, surface the paralysis.
        recordSystemEvent({
          userId: run.userId, source: "drive_update", severity: "warn",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `drive update validation failed twice (${lastError}) — sheets not updated this run`,
        });
        this.runs.markCompleted(run.id, new Date().toISOString(), `Drive sheets unchanged (validation failed: ${lastError})`, JSON.stringify({ updated: 0, written: false }));
        this.runs.updateRun(run.id, { approvedAt: new Date().toISOString() });
        return;
      }

      let updated = 0, skippedUserEdit = 0, skippedChanged = 0;
      const staleFound: Array<{ name: string; id: string; text: string; pressure: number; sinceTurn: number | null }> = [];
      this.lorebook.transact(() => {
        assertSource();
        for (const c of accepted) {
          const prior = existing.get(c.name);
          // User-edit protection: a human who edited this sheet DURING the run wins.
          const live = this.drives.findByCharacter(run.campaignId, c.name);
          if (live && live.source === "user" && live.updatedAt > startedAt) { skippedUserEdit++; continue; }
          // Any OTHER writer that touched the sheet since the snapshot:
          // a manual world-tick apply's drive effects land as `source: "worker"`
          // between this run's read and its write, and merging the model's
          // re-emission over the STALE snapshot would overwrite the tick's
          // pressure decay and its "(done offscreen …)" stamp — the want would
          // regenerate at the old pressure. Skip; the next run re-derives from
          // the newer sheet.
          if (live && live.updatedAt !== (prior?.updatedAt ?? null)) { skippedChanged++; continue; }
          const sheet = mergeSheet(c, prior?.sheet ?? null, turnNumber);
          for (const w of staleWants(sheet)) staleFound.push({ name: c.name, ...w });
          this.drives.upsert({
            campaignId: run.campaignId, characterName: c.name, sheet,
            turn: turnNumber, messageId: null, source: "worker", recordHistory: true,
          });
          updated++;
        }
      });
      if (skippedUserEdit > 0 || skippedChanged > 0) {
        recordSystemEvent({
          userId: run.userId, source: "drive_update", severity: "info",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `drive update skipped ${skippedUserEdit + skippedChanged} sheet(s) changed during the run (${skippedUserEdit} edited by you, ${skippedChanged} by another writer such as a world-tick apply) — the newer sheets are kept; the next run re-derives from them`,
          details: { runId: run.id, skippedUserEdit, skippedChanged },
        });
      }
      // Measurement (2026-09-26): a want carried unengaged to STALE_WANT_PRESSURE is what
      // the agenda line renders as "wants URGENTLY". Say so once at the threshold and
      // every third update after, so a want canon has quietly settled is visible
      // before it becomes a week of the same question.
      const staleToReport = staleFound.filter((w) => (w.pressure - STALE_WANT_PRESSURE) % 3 === 0);
      if (staleToReport.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "drive_update", severity: "info",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `stale want${staleToReport.length > 1 ? "s" : ""}: ${staleToReport.slice(0, 5).map((w) => `${w.name} ${w.id} "${w.text.slice(0, 80)}" pressure ${w.pressure}${w.sinceTurn != null ? ` since turn ${w.sinceTurn}` : ""}`).join("; ")} — the composer is told to act on ${staleToReport.length > 1 ? "these" : "this"} now; if canon has settled it, remove it in the drives editor`,
          details: { runId: run.id, stale: staleFound },
        });
      }
      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt, `Drive update: ${updated} sheet(s) updated${skippedUserEdit ? `, ${skippedUserEdit} user-edited skipped` : ""}${skippedChanged ? `, ${skippedChanged} changed-mid-run skipped` : ""}`, JSON.stringify({ updated, skippedUserEdit, skippedChanged, modelId }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "drive update failed", null);
    }
  }
}

// Pressure lives server-side (skew-immune vs. asking the LLM to do arithmetic):
// a carried-forward want engaged this window resets to 0; otherwise +1. New wants start at 0.
// `sinceTurn` = the turn the want was last engaged — or first seen —
// so a renderer can say "unaddressed since turn 41": engaged → the current
// turn (fresh), unengaged → carried forward, new → the current turn. It was
// scaffolding written as null by every writer; the worker now produces it.
export function mergeSheet(c: LlmCharacter, prior: DriveSheet | null, turnNumber: number | null = null): DriveSheet {
  const priorWants = new Map((prior?.wants ?? []).map(w => [w.id, w]));
  const wants = (c.wants ?? []).slice(0, 5).map(w => {
    const prev = priorWants.get(w.id);
    // On hold (2026-09-27): a want the character cannot reach keeps its pressure instead of climbing.
    const blocked = Boolean(w.blocked) && !w.engaged;
    const pressure = w.engaged ? 0 : (prev == null ? 0 : (blocked ? prev.pressure : Math.min(20, prev.pressure + 1)));
    const sinceTurn = w.engaged || prev == null ? turnNumber : (prev.sinceTurn ?? turnNumber);
    return { id: w.id, text: w.text, pressure, sinceTurn, ...(blocked ? { blocked: true } : {}) };
  });
  return driveSheetSchema.parse({
    wants,
    goals: (c.goals ?? []).slice(0, 3),
    redLines: (c.redLines ?? []).slice(0, 6),
    leverage: (c.leverage ?? []).slice(0, 6),
    offpageProject: c.offpageProject ?? null,
    concealment: (c.concealment ?? []).slice(0, 4),
    dispositions: Object.fromEntries(Object.entries(c.dispositions ?? {}).slice(0, 6)),
  });
}

function sheetToLlm(name: string, s: DriveSheet) {
  return {
    name,
    wants: s.wants.map(w => ({ id: w.id, text: w.text, ...(w.blocked ? { blocked: true } : {}) })),
    goals: s.goals,
    redLines: s.redLines,
    leverage: s.leverage,
    offpageProject: s.offpageProject,
    concealment: s.concealment,
    dispositions: s.dispositions,
  };
}

// Truncate to a driveSheetSchema string cap. Models drift past hard limits no
// matter what the prompt says ("too_big" Zod rejections killed whole drive runs
// on 2026-07-06/07); truncating one field beats failing every sheet in the
// run. trimEnd keeps the result valid for the schema's .trim().max(N) fields.
function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

export function parseCharacters(text: string, allowed: Set<string>): LlmCharacter[] | null {
  const parsed = parseFirstJson<{ characters?: unknown[] }>(text, "{");
  if (!Array.isArray(parsed?.characters) || parsed.characters.some((c) => !c || typeof c !== "object" || typeof (c as { name?: unknown }).name !== "string")) return null;
  const arr = parsed.characters;
  // Caps and lengths mirror driveSheetSchema (contracts/drives.ts) — arrays are
  // sliced and strings clamped here so an overachieving model degrades to a
  // trimmed sheet instead of a failed run.
  return arr.map((c: any) => ({
    name: String(c?.name ?? "").trim(),
    wants: Array.isArray(c?.wants) ? c.wants.map((w: any) => ({ id: clamp(String(w?.id ?? "").trim() || slug(), 64), text: clamp(String(w?.text ?? "").trim(), 400), engaged: Boolean(w?.engaged), blocked: Boolean(w?.blocked) })).filter((w: LlmWant) => w.text).slice(0, 5) : [],
    goals: Array.isArray(c?.goals) ? c.goals.map((g: any) => ({ id: clamp(String(g?.id ?? "").trim() || slug(), 64), text: clamp(String(g?.text ?? "").trim(), 400), status: normStatus(g?.status) })).filter((g: any) => g.text).slice(0, 3) : [],
    redLines: Array.isArray(c?.redLines) ? c.redLines.map((x: any) => clamp(String(x).trim(), 300)).filter(Boolean).slice(0, 6) : [],
    leverage: Array.isArray(c?.leverage) ? c.leverage.map((x: any) => clamp(String(x).trim(), 300)).filter(Boolean).slice(0, 6) : [],
    offpageProject: c?.offpageProject ? clamp(String(c.offpageProject).trim(), 600) || null : null,
    concealment: Array.isArray(c?.concealment) ? c.concealment.map((x: any) => ({ secret: clamp(String(x?.secret ?? "").trim(), 300), behavior: clamp(String(x?.behavior ?? "").trim(), 400) })).filter((x: any) => x.secret && x.behavior).slice(0, 4) : [],
    dispositions: c?.dispositions && typeof c.dispositions === "object" ? Object.fromEntries(Object.entries(c.dispositions).map(([k, v]) => [String(k).trim(), clamp(String(v).trim(), 400)]).filter(([k, v]) => k && v).slice(0, 6)) : {},
  })).filter((c: LlmCharacter) => c.name && allowed.has(c.name));
}

export function validate(chars: LlmCharacter[], prior: Map<string, { sheet: DriveSheet }>): { ok: true } | { ok: false; error: string } {
  // A character whose PRIOR sheet had content must not come back empty (guards a
  // model wiping a sheet). Missing characters are allowed (nothing to say this run).
  // Count caps are NOT re-checked here: parseCharacters slices every
  // array to the schema cap before this runs, so those branches could never
  // fire — the cap is the slice (a trimmed sheet beats a failed run).
  for (const c of chars) {
    const priorSheet = prior.get(c.name)?.sheet;
    const priorHad = priorSheet && (priorSheet.wants.length > 0 || priorSheet.goals.length > 0);
    const nowEmpty = c.wants.length === 0 && c.goals.length === 0 && !c.offpageProject;
    if (priorHad && nowEmpty) return { ok: false, error: `${c.name} was returned empty but had a populated sheet — re-emit it` };
  }
  return { ok: true };
}

function normStatus(s: unknown): "active" | "achieved" | "abandoned" | "blocked" {
  const v = String(s ?? "active").toLowerCase();
  return v === "achieved" || v === "abandoned" || v === "blocked" ? v : "active";
}
function safeScene(raw: string | null | undefined): { present?: string[]; presentUnaware?: string[] } | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function safeObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
function truncate(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max) + "…"; }
function slug(): string { return "w" + Math.abs(hash(Math.random().toString())).toString(36).slice(0, 6); }
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── Settled-facts canon check (2026-09-26) ─────────────────────────────────────
// Deterministic and free: no model call, no embedding. For each carried want, the
// sentences of the character's own records (and the campaign rules) that share the
// most distinctive terms with the want's text — the material that says "the duffel
// is gone" when the want says "recover the duffel". The model reads them under
// rule 8; the worker never decides for it.
const CANON_STOPWORDS = new Set(["about", "above", "after", "again", "against", "along", "already", "among", "another", "anyone", "anything", "around", "because", "before", "being", "below", "between", "could", "during", "earlier", "either", "enough", "every", "first", "having", "herself", "himself", "itself", "later", "maybe", "might", "never", "nothing", "often", "other", "others", "rather", "really", "should", "since", "someone", "something", "still", "their", "there", "these", "those", "through", "toward", "under", "until", "where", "whether", "which", "while", "without", "within", "would", "actually", "possible", "instead", "further", "whose", "while", "though", "although", "unless", "until", "however", "anyway", "genuinely", "toward", "please", "thing", "things", "wants", "trying", "getting", "keep", "keeps", "keeping", "make", "makes", "making", "again", "himself", "that", "this", "with", "from", "into", "onto", "over", "when", "what", "they", "them", "then", "than", "have", "been", "were", "will", "must", "also", "like", "just", "even", "more", "most", "some", "such", "only", "very", "much", "many", "each", "both", "once", "upon", "here", "back", "down", "away", "take", "gives", "give", "want", "need", "know", "tell", "told", "asks", "asked", "come", "came", "goes", "gone", "went", "does", "done", "said", "says", "sees", "seen", "look", "next", "last", "same", "else", "ever", "soon", "near", "true", "real", "well", "good", "less", "least", "long", "high", "left", "right", "still", "their", "there", "where", "whose"]);

export function isRecordOf(entryName: string, characterName: string): boolean {
  if (!characterName.trim()) return false;
  // The record's subject is the name before " — " (or " – ", " - ", ":"), compared by key so a core titled
  // "Sheriff Doran Vale" and its satellites count as Doran Vale's own records (2026-09-27).
  const subject = entryName.trim().split(/ [—–-] |: /)[0] ?? "";
  return characterNameKey(subject) === characterNameKey(characterName);
}

export function canonSentences(content: string, maxChars = CANON_CHECK_SENTENCE_CHARS): string[] {
  const cleaned = content.replace(/\*\*/g, "").replace(/^\s*[-•*]\s+/gm, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ");
  return cleaned.split(/(?<=[.!?])\s+(?=[A-Z"“(\[])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 25 && x.length <= 900)
    .map((x) => (x.length > maxChars ? `${x.slice(0, maxChars - 1).trimEnd()}…` : x));
}

export function wantTerms(text: string): string[] {
  const tokens = text.match(/[A-Za-z][A-Za-z'’-]+/g) ?? [];
  const out = new Set<string>();
  tokens.forEach((raw, i) => {
    const word = raw.replace(/['’]s$/, "");
    const lower = word.toLocaleLowerCase();
    if (CANON_STOPWORDS.has(lower)) return;
    // A capitalized word is a name unless it opens the text (imperative wants start "Ask …", "Get …").
    const name = /^[A-Z]/.test(word) && (i > 0 ? word.length >= 3 : word.length >= 5);
    if (word.length >= 4 || name) out.add(lower.length > 5 ? lower.slice(0, 5) : lower);
  });
  return [...out];
}

/**
 * Everything on a sheet that carries forward by re-emission and can go stale
 * the same way a want does: the wants (their own ids), the concealments (c1…
 * in sheet order — the prompt keys them the same way) and the off-page project.
 */
export function carriedItems(sheet: Pick<DriveSheet, "wants" | "concealment" | "offpageProject">): Array<{ id: string; text: string }> {
  const items: Array<{ id: string; text: string }> = sheet.wants.map((w) => ({ id: w.id, text: w.text }));
  sheet.concealment.forEach((c, i) => items.push({ id: `c${i + 1}`, text: `${c.secret} ${c.behavior}` }));
  if (sheet.offpageProject?.trim()) items.push({ id: "offpage", text: sheet.offpageProject });
  return items;
}

export interface CanonCheckHit { id: string; sentences: string[] }
/** Sentences from `records` that share terms with each carried item (wants or anything from carriedItems). */
export function canonCheckForWants(
  records: Array<{ name: string; content: string }>,
  wants: Array<{ id: string; text: string }>,
  limits: { perWant?: number; sentenceChars?: number } = {},
): CanonCheckHit[] {
  const perWant = limits.perWant ?? CANON_CHECK_PER_WANT;
  const sentenceChars = limits.sentenceChars ?? CANON_CHECK_SENTENCE_CHARS;
  const pool = records.flatMap((r) => canonSentences(r.content, sentenceChars).map((sentence) => ({ record: r.name, sentence, lower: sentence.toLocaleLowerCase() })));
  const hits: CanonCheckHit[] = [];
  for (const want of wants) {
    const terms = wantTerms(want.text);
    if (terms.length === 0) continue;
    const need = Math.min(2, terms.length);
    const matchers = terms.map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    const scored = pool
      .map((p) => ({ p, score: matchers.reduce((n, re) => n + (re.test(p.lower) ? 1 : 0), 0) }))
      .filter((x) => x.score >= need)
      .sort((a, b) => b.score - a.score || a.p.sentence.length - b.p.sentence.length)
      .slice(0, perWant);
    if (scored.length > 0) hits.push({ id: want.id, sentences: scored.map((x) => `[${x.p.record}] ${x.p.sentence}`) });
  }
  return hits;
}

/** Wants the composer is told to act on NOW (pressure ≥ STALE_WANT_PRESSURE). */
export function staleWants(sheet: DriveSheet): Array<{ id: string; text: string; pressure: number; sinceTurn: number | null }> {
  return sheet.wants.filter((w) => !w.blocked && w.pressure >= STALE_WANT_PRESSURE).map((w) => ({ id: w.id, text: w.text, pressure: w.pressure, sinceTurn: w.sinceTurn ?? null }));
}
