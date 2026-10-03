import { pipelineInputsForRun } from "./settledSourceGuard";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { confirmOffscreenEntry } from "../../../api/src/domain/world/offscreen";
import { PresenceResolver } from "../../../api/src/domain/context/characterPresence";
import { createDatabaseClient, migrateDatabase, type DatabaseClient } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, withTimeout, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { resolveWorkerModel } from "./workerModel";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { resolveCampaignEmbedModel } from "../../../api/src/domain/context/embedModelResolver";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";
import { stripOocBlocks } from "../../../api/src/domain/context/stripOoc";
import { EPISTEMIC_STATUS_RULE } from "./epistemicStatus";
import { canonSourceVersion } from "./canonSourceVersion";
import { workerTurnNumber } from "./turnOrdinal";
import { countHeldByReason, describeHeldOps, type HeldOp, type HeldOpReason } from "./heldOps";
import { sanitizeCreateTag } from "../../../api/src/domain/context/lorebookTags";
import { mergeKeyLists, normalizeKeyList, parseStoredKeys, type MergedKeys } from "../../../api/src/domain/context/lorebookKeys";
import { KeyCapNotes } from "./keyCapNotes";
import { normalizeKnownBy } from "../../../api/src/domain/context/lorebookKnownBy";
import { workerDisableRefusal } from "./workerDisable";
import { NEVER_DELIVERED_IDLE_MS, deliveryEvidence, idleMs, otherSessionsLabel, type DeliveryEvidence } from "./deliveryEvidence";
import { latestCoverageMarker, planPasses, readCoverageMarker, selectSpan, type PassCaps } from "./transcriptSpan";
import { completeRun } from "./runCompletion";
import type { CampaignActivationEvidence } from "../../../api/src/domain/context/lorebookRepository";

// Synonym expansion bounds an entry's key list at this many keys. It caps
// GROWTH only — an entry that already carries more (curation, the bulk
// append-keys feature, the 05-24 key-augmentation pass) never loses keys to
// it.
const SYNONYM_KEY_CAP = 20;
// Synonym keys are short phrases (the old `< 60` filter): a model's sentence
// never becomes a key. The live list itself is only held to the contract.
const SYNONYM_KEY_MAX_CHARS = 59;

const ROLLING_DIFF_SYSTEM = `You are maintaining the canonical lorebook for an ongoing roleplay campaign. The lorebook records every character, location, faction, event, and persistent fact. You will read the most recent turns and emit a list of CRUD operations on the lorebook so it stays current.

Each message is annotated with scene_state showing who was physically present. Use this to set known_by on entries that record private knowledge.
${EPISTEMIC_STATUS_RULE}

IMPORTANT — Duplicate Prevention:
Before issuing a CREATE, carefully check the <existing_entries> list. If an entry already covers the same topic, character detail, location, or event — UPDATE that entry instead of creating a new one. Duplicates waste context budget and degrade retrieval quality. Look for:
- Entries with the same or similar names
- Entries whose content already covers what you would write
- Entries that could be expanded to include the new information

Tag taxonomy (choose carefully — tag determines lifecycle):
- "characters" — persistent world-building: a person, named NPC, or player character. Never archived.
- "locations" — persistent world-building: places, buildings, regions. Never archived.
- "factions" — persistent world-building: groups, organizations, governments. Never archived.
- "capabilities" — STABLE ABILITIES, divine powers, magical skills, technical competencies that a character can repeatedly use (e.g. "Aldric can conjure food from nothing", "Bram can cast Somnium Lenis"). Never archived.
- "traits" — STABLE PERSONALITY/BEHAVIOR PATTERNS that recur across scenes (e.g. "Aldric is pathologically possessive", "Nessa uses command voice when nervous"). Never archived.
- "relationships" — STABLE DYNAMICS between characters (e.g. "Mara and Nessa's emerging friendship", "Aldric-Bram mentor pattern"). Never archived.
- "rules" — meta-rules, relationship governance, protocols (e.g. "honesty at all costs", "no surprise public reveals"). Never archived.
- "lore" — world facts, history, mythology, terminology that exists in-universe. Never archived.
- "events" — a SPECIFIC MOMENT in time: a scene, conversation, decision, or one-time occurrence. CAN be archived once stale.
- "threads" — RESERVED for the automated thread tracker (pending quests/operations/plot threads). NEVER create, modify, or disable "threads" entries — they are owned by a separate worker.

CRITICAL: a capability or trait is what a character IS or CAN DO across all scenes. An event is what HAPPENED in one scene. The same fact can appear in BOTH: an event entry captures "Aldric conjured Cuban food on Sept 16"; a capability entry captures "Aldric can conjure food from nothing (divine ability)". The capability is queryable for any future scene; the event is a specific moment.

MAINTAIN CURRENT STATE ON CHARACTER ENTRIES — this is a standing obligation, not an optional extra.
A character entry is the ONE entry that retrieves whenever that character is on stage, so it is where the story's present tense has to live. Every character entry for someone who appeared in these turns must carry a section headed exactly:

**CURRENT STATE — <in-world date>:**

Fold this run's developments into that section by UPDATE, and re-date the heading. It holds only what is true RIGHT NOW and would change how the character is written in the next scene:
- physical condition — injuries, what caused each one, whether it was treated, what is visibly wrong with them
- bindings, oaths, allegiances, ranks, and who they answer to
- what they are wearing or carrying when it is operationally distinctive
- where they are and what they are in the middle of doing
- their current standing with the other characters

Rules for it:
1. State causes, never just symptoms. "She limps" invites the next writer to invent a reason; "she limps from X, which Y deliberately left unhealed" does not. An unexplained condition WILL be given a wrong explanation.
2. NEGATE what is likely to be mis-assumed. If a character is repeatedly written as having an injury or history they do not have, say so in the entry in as many words: "She was never shot — she is the one who fired." An absent fact cannot contradict a wrong guess.
3. Older narrative sections of the entry stay, but the moment one is superseded, label it (e.g. "HISTORICAL, June 3 — superseded by CURRENT STATE") rather than deleting it or leaving it to be read as present tense. Labeled HISTORICAL sections are candidates to MOVE OUT under rule 5 — they never silently vanish.
4. Prefer putting a durable, currently-true fact (condition, binding, standing, capability, relationship) on the CHARACTER entry over creating another event entry for it — but the character entry is NOT an archive. Dated scene-by-scene narrative belongs in events entries; the character entry holds the identity and current-state distillation.
5. SIZE GOVERNOR — the character entry force-loads in every scene its character is in, so every character it describes pays its size on every single turn. If your UPDATE would leave a character entry longer than about 12,000 characters, MOVE the oldest settled HISTORICAL sections VERBATIM into a companion events entry named "<Character> — <arc> Records (<dates>)" (a CREATE in the same output; keys = arc-specific terms only: distinctive names, objects, places and events from the moved text, NEVER the character's own name or the core entry's keys, because a record keyed on the character loads in every scene the core loads in and the move saves nothing), keep the character entry to identity, voice, capabilities, relationships, and the dated CURRENT STATE, and leave a one-line pointer to the records entries. Relocation is not deletion: never discard, summarize away, or paraphrase the moved text. ENFORCED IN CODE: a character UPDATE or CREATE over 12,000 characters is sent back once to be re-authored under the cap; an events CREATE or UPDATE over 9,000 characters likewise (split it into two records). Prefer relocating history over compressing it.

COVERAGE CONTRACT — enforced by the server, not optional:
The <appeared_character_entries_full> section (when present) lists, with FULL current content, the character entries of everyone detected in these turns. For EVERY entry in that section your output MUST contain exactly one of:
- an UPDATE for that entry_id — a careful revision of the full text shown: preserve everything still true, fold in this run's developments, maintain the dated CURRENT STATE section; or
- {"op": "CHARACTER_UNCHANGED", "entry_id": "..."} — an explicit declaration that these turns changed nothing worth recording for that character.
Silently omitting an appeared character is rejected and you will be asked again. Never declare CHARACTER_UNCHANGED for a character whose condition, location, bindings, standing, or ongoing activity visibly changed in these turns.
Entries NOT shown in full appear only as 120-character summaries. An UPDATE to one of those is a proposal only: the server will ask you to re-author it against the full source before it can replace anything. Never infer that a summary proves the unseen tail is superseded.

Operations:
- CREATE: a new entry (only when no existing entry covers this topic). Provide name, tag, content, keys (array of trigger words), and known_by.
  - known_by: JSON array of character names who witnessed or were told this information. Use null for global/world knowledge (locations, lore, rules, character descriptions, capabilities, traits). Use specific names for events, conversations, or discoveries that only certain characters witnessed.
- UPDATE: edit an existing entry. Provide entry_id, content, and optionally known_by (if knowledge has spread to new characters).
- DISABLE: soft-disable an "events" entry or an offscreen entry (named "Offscreen — …") that is no longer canonical. Rare. The entry is kept for archival and can be restored. Provide entry_id. The server holds a DISABLE of any other entry for hand curation, so correct a character, location, faction, lore or rule entry with an UPDATE instead.
- CONFIRM_OFFSCREEN: entries named "Offscreen — …" are provisional background events the player hasn't witnessed. When the recent turns SHOW that event happening on-screen, or a character openly references it as having happened, emit {"op": "CONFIRM_OFFSCREEN", "entry_id": "..."} — the event graduates into established canon. (If the turns CONTRADICT an offscreen entry instead, DISABLE it — the live transcript always wins.)
- CHARACTER_UNCHANGED: explicit no-change declaration for an entry listed in <appeared_character_entries_full>. Provide entry_id. Valid only for entries in that section.
- NOOP: no changes needed (the recent turns introduce nothing new).

Output ONLY a JSON array of operations. Example:
[
  {"op": "CREATE", "name": "Secret Meeting", "tag": "events", "content": "...", "keys": ["meeting"], "known_by": ["Bram", "Aldric"]},
  {"op": "CREATE", "name": "New Location", "tag": "locations", "content": "...", "keys": ["location name"], "known_by": null},
  {"op": "UPDATE", "entry_id": "...", "content": "...", "known_by": ["Bram", "Aldric", "Doran"]},
  {"op": "CHARACTER_UNCHANGED", "entry_id": "..."},
  {"op": "NOOP"}
]`;

const STALENESS_ADDENDUM = `\n\nA <stale_review> section is included below. Each entry includes activation metadata:
- never_activated=true means no session of this campaign has ever delivered this entry into the model's context, so the story has never needed it
- last_activated_turn shows the turn of this session in which it was last delivered (compare to current_turn). "not in this session" means only other sessions of this campaign delivered it, so the story has used it

Guidelines for stale review:
- DISABLE one-time micro-events (tag=events) that have never activated and are unlikely to ever be relevant again (e.g. a throwaway joke, a single reaction, a minor conversational beat from hundreds of turns ago)
- DO NOT disable entries that are still being delivered into context — they are working as intended regardless of age
- DO NOT disable entries tagged characters, locations, factions, lore, rules, capabilities, traits, relationships, or threads — these are persistent world-building (and, for threads, pending narrative obligations) and must remain queryable regardless of activation frequency. They may simply not have been thematically relevant yet.
- UPDATE entries that contain outdated facts but are still relevant
- When in doubt, NOOP — keeping an unused entry is better than disabling one that matters`;

interface DiffOp {
  op: "CREATE" | "UPDATE" | "DELETE" | "DISABLE" | "CONFIRM_OFFSCREEN" | "CHARACTER_UNCHANGED" | "NOOP";
  entry_id?: string;
  name?: string;
  tag?: string;
  content?: string;
  keys?: string[];
  known_by?: string[] | null;
}

// Size governor as code (2026-09-25). The prompt has asked for the
// ~12,000-char character cap since 2026-08-27 and one long campaign's cores regrew
// past it anyway (nine of them 12.3k–16.6k chars, taxing every turn they are in).
// The check runs on the diff's own output path: any oversize character or events
// op gets ONE re-author follow-up (relocate history into a Records satellite /
// split the record); if the replacement is still over the cap the original is
// applied — never lose canon — and a system event names it.
export const CHARACTER_ENTRY_MAX_CHARS = 12000;
export const EVENT_ENTRY_MAX_CHARS = 9000;
export const COMPANION_ENTRY_MAX_CHARS = 24000; // a Records satellite may be large (scored, not guaranteed) but must stay under the embed cap
const SIZE_GOVERNOR_MAX_FOLLOWUPS = 3;
// Passes. A run reads every settled message since the
// previous diff of its session, in passes of whole exchanges. The caps come from
// a 2026-09-29 measurement of two long campaigns: consecutive diffs were 18–86
// messages apart on one (average 40.8) and 14–58 on the other (29.9), and their
// recent messages average 1.1k–1.6k characters, so 48 messages / 80,000
// characters reads the usual span in ONE pass (one main call, as before) and the
// long ones in two. A pass's fixed cost is large and its window small (on one long
// campaign ~60k tokens of system prompt, entry snippets and appeared characters
// against ~5–23k of window; a main call takes about 20 minutes at max effort on
// the bridge), so smaller passes would multiply the calls without reading
// anything more. The output is bounded by the 12 appeared characters per pass,
// not by the window. A single exchange larger than a cap is a pass of its own.
export const DIFF_PASS_CAPS: PassCaps = { maxMessages: 48, maxChars: 80_000 };
// A session's first diff, or the first after legacy runs that carry no
// coverage marker, reads the old window.
const DIFF_FALLBACK_WINDOW = 8;

/** One pass of a run, as its details record it. */
export interface DiffPassRecord { fromSortOrder: number; throughSortOrder: number; messages: number; chars: number; ops: number; applied: number }

/** The fields of a rolling-diff run's details this worker reads. */
interface RollingDiffRunDetails {
  rollingModel?: string;
  staleSweep?: boolean;
  embeddingModel?: string;
  workerEffort?: string;
  openaiFastMode?: boolean;
  coveredFromSortOrder?: number;
  coveredThroughSortOrder?: number;
  coveredReadAt?: string;
  passes?: DiffPassRecord[];
}

// Full-source re-authors of blind UPDATEs per run (default 6). Each is
// a sequential full-deadline model call; past the budget the UPDATE is held
// (existing canon kept) and named in the held-UPDATE warn.
export const BLIND_REAUTHOR_MAX_PER_RUN = 6;

// Unlinked records (2026-09-28): two lorebook entries indelibly linked are the same as
// one large lorebook entry as far as the dynamic context budget is concerned. A "<Owner> — <arc>
// Records (…)" companion or a ", part N" split keyed on the owner's name fires whenever the owner is
// named, which is every scene the core itself loads in, so the relocation saved nothing. Records and
// parts are keyed on their own arc terms and never chain through recursion.
const RECORDS_NAME = /^(.+?)\s+—\s+.*\bRecords\b/;
const PART_NAME = /(?:,|—|-)\s*part\s+\d+(?:\s+of\s+\d+)?\b/i;
/** The owner a Records companion belongs to ("Mara — Supper Records (7 October)" → "Mara"), else null. */
export function recordsOwner(name: string): string | null {
  const m = RECORDS_NAME.exec(name.trim());
  return m ? m[1]!.trim() : null;
}
export function isRecordsOrPartName(name: string): boolean {
  return recordsOwner(name) !== null || PART_NAME.test(name);
}
/** Keys minus the ones that link a record to its core: the owner's name and each word of it (3+
 *  letters), plus any `extraLinked` (the core's own name keys, the campaign's PC keys). Order kept,
 *  case-insensitive de-duplication. Exported for the compaction and re-key tools and for tests. */
export function unlinkRecordsKeys(name: string, keys: string[], extraLinked: string[] = []): string[] {
  const linked = new Set(extraLinked.map((k) => k.trim().toLocaleLowerCase()).filter(Boolean));
  const owner = recordsOwner(name);
  if (owner) {
    const o = owner.toLocaleLowerCase();
    linked.add(o);
    for (const w of o.split(/\s+/)) if (w.length >= 3) linked.add(w);
  }
  const out: string[] = [];
  for (const raw of keys) {
    const k = raw.trim();
    if (!k || linked.has(k.toLocaleLowerCase()) || out.some((x) => x.toLocaleLowerCase() === k.toLocaleLowerCase())) continue;
    out.push(k);
  }
  return out;
}

/** The ops whose content would leave an entry over its tag's cap. Exported for tests. */
export function findOversizeOps(ops: DiffOp[], tagOf: (entryId: string) => string | null | undefined): Array<{ index: number; tag: string; cap: number; length: number }> {
  const out: Array<{ index: number; tag: string; cap: number; length: number }> = [];
  ops.forEach((op, index) => {
    if (typeof op.content !== "string") return;
    let tag: string | null | undefined;
    if (op.op === "CREATE") tag = op.tag;
    else if (op.op === "UPDATE" && op.entry_id) tag = tagOf(op.entry_id);
    else return;
    const cap = tag === "characters" ? CHARACTER_ENTRY_MAX_CHARS : tag === "events" ? EVENT_ENTRY_MAX_CHARS : null;
    if (cap !== null && op.content.length > cap) out.push({ index, tag: tag!, cap, length: op.content.length });
  });
  return out;
}

/**
 * Which character entries did these turns touch? The same presence resolver as the
 * engine's scene-present guarantee (characterPresence.ts, 2026-09-29): a present-list
 * name finds the entries that ARE that person, and the turn text counts an entry
 * when it mentions the person by one of their own names or aliases. An entry that
 * merely carries someone's name as a key (Doran's entry keyed "Petra Vale")
 * no longer counts as appeared whenever that person is named; neither do keys
 * several people share unless the key is part of the person's own name, nor a
 * player character's name.
 *
 * The result is the set the worker shows IN FULL and holds the coverage contract
 * over — so it deliberately excludes constants (UPDATE refuses them) and caps at
 * `cap`, present characters first, stalest-updated first within each group (the
 * entries most in need of a CURRENT STATE pass get the slots). Only what is shown
 * in full is required: demanding coverage of an entry the model saw as a
 * 120-character snippet would force blind rewrites — the exact failure this
 * mechanism exists to end. Constants still take part in resolution, so a key
 * naming a constant character stays a relationship key.
 */
export function detectAppearedCharacterEntries(input: {
  entries: Array<{ id: string; name: string; tag: string | null; keys: string; isConstant: number; updatedAt: string }>;
  windowText: string;
  presentNames: string[];
  /** The session's player-character names: never another entry's alias. */
  playerNames?: readonly string[];
  cap?: number;
}): string[] {
  const cap = input.cap ?? 12;
  const characters = input.entries.filter((e) => e.tag === "characters");
  const resolver = new PresenceResolver(
    characters.map((e) => ({ id: e.id, name: e.name, tag: e.tag, keys: parseStoredKeys(e.keys) })),
    { playerNames: input.playerNames },
  );
  const eligible = new Map(characters.filter((e) => e.isConstant !== 1).map((e) => [e.id, e]));
  const presentIds = new Set(resolver.resolveAll(input.presentNames, input.windowText).entryIds.filter((id) => eligible.has(id)));
  const windowIds = resolver.appearedIn(input.windowText).filter((id) => eligible.has(id) && !presentIds.has(id));
  const stalestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? -1 : 1);
  const presentHits = [...presentIds].map((id) => eligible.get(id)!).sort(stalestFirst);
  const windowHits = [...new Set(windowIds)].map((id) => eligible.get(id)!).sort(stalestFirst);
  return [...presentHits, ...windowHits].slice(0, cap).map((h) => h.id);
}

/** The session's player-character names (the Engine panel's player character keys); [] when unset or unreadable. */
export function sessionPlayerNames(contextOverridesJson: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(contextOverridesJson || "{}") as { playerCharacterKeys?: unknown };
    return Array.isArray(parsed.playerCharacterKeys) ? parsed.playerCharacterKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0) : [];
  } catch {
    return [];
  }
}

/** The coverage check (mirrors validateTrackerDelta's role for threads): every
 *  required entry must be explicitly accounted for. UPDATE and CHARACTER_UNCHANGED
 *  are the expected answers; a DISABLE/DELETE counts only when `disableApplies`
 *  says the worker may apply it: a held DISABLE leaves the entry exactly as it
 *  was, so counting it would let an appeared character go unreviewed.
 *  The default keeps the older rule for callers without a policy. */
export function findUncoveredCharacterIds(ops: Array<{ op: string; entry_id?: string }>, requiredIds: string[], disableApplies: (entryId: string) => boolean = () => true): string[] {
  const covered = new Set<string>();
  for (const op of ops) {
    if (!op.entry_id) continue;
    if (op.op === "UPDATE" || op.op === "CHARACTER_UNCHANGED") covered.add(op.entry_id);
    else if ((op.op === "DISABLE" || op.op === "DELETE") && disableApplies(op.entry_id)) covered.add(op.entry_id);
  }
  return requiredIds.filter((id) => !covered.has(id));
}

/**
 * Merge synonym keys onto an entry's existing keys through the shared key
 * helper: the live list is trimmed, deduplicated
 * case-insensitively and held to LOREBOOK_MAX_KEYS; proposed keys longer than a
 * short phrase are ignored. The growth cap bounds the ADDED keys only:
 * `existing` is the entry's live key list on an UPDATE, and this used to
 * `slice(0, cap)` the union, which silently shed keys 21+ from any curated
 * entry on every obligated character UPDATE; keys are the retrieval mechanism.
 * Every limit that binds is in the result, for the run's details.
 */
export function mergeSynonymKeysDetailed(existing: unknown, proposed: unknown, cap = SYNONYM_KEY_CAP): MergedKeys {
  const candidates = (Array.isArray(proposed) ? proposed : [proposed])
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0 && k.trim().length <= SYNONYM_KEY_MAX_CHARS);
  return mergeKeyLists(existing, candidates, { growthCap: cap });
}

/** `mergeSynonymKeysDetailed`'s list, or null when nothing was added. */
export function mergeSynonymKeys(existing: string[], proposed: unknown[], cap = SYNONYM_KEY_CAP): string[] | null {
  const merged = mergeSynonymKeysDetailed(existing, proposed, cap);
  return merged.added.length > 0 ? merged.keys : null;
}

/** The key list a diff CREATE stores: normalized by the shared helper
 *  and capped at LOREBOOK_MAX_KEYS; a Records companion or split part first
 *  loses its owner's keys (unlinked records, 2026-09-28). Exported for tests. */
export function createKeysFor(name: string, proposed: unknown): ReturnType<typeof normalizeKeyList> {
  if (!isRecordsOrPartName(name)) return normalizeKeyList(proposed);
  const all = normalizeKeyList(proposed, { max: Number.MAX_SAFE_INTEGER });
  const unlinked = normalizeKeyList(unlinkRecordsKeys(name, all.keys));
  return { ...unlinked, overLong: [...all.overLong, ...unlinked.overLong] };
}

/** The tag a rolling-diff CREATE lands with: reserved lifecycle tags
 *  (`threads`, owned by the tracker; `archived`, the compressed-trigger tier)
 *  fall back to `events`, since the prompt forbids them but the code must
 *  enforce it; blank is null; a tag past the contract's length is cut to it.
 *  One sanitizer for every machine and import CREATE path since 2026-09-29;
 *  this name stays for the diff's callers and tests. */
export { sanitizeCreateTag } from "../../../api/src/domain/context/lorebookTags";

// ── Prompt builders (module level since 2026-09-29) ─────────────────────────
// The worker assembles every model input through these, and offline measurement
// tools can build the same text without a model call.

/** A transcript row as the diff renders it. */
export interface DiffTranscriptRow { role: string; content: string; sceneData?: string | null }

/** The transcript window as the diff shows it: OOC stripped (OOC blocks are
 *  direction to the composer, never events; a canon writer reading a
 *  beat-sheet as played reality is the 2026-08-26 debut-scene failure, see
 *  stripOoc.ts), a scene line before each assistant turn that has one, and the
 *  names the scenes mark present or present-unaware. */
export function renderDiffWindow(rows: readonly DiffTranscriptRow[]): { text: string; presentNames: string[] } {
  const presentNames = new Set<string>();
  const text = rows.map(m => {
    let line = `[${m.role}]: ${stripOocBlocks(m.content)}`;
    if (m.role === "assistant" && m.sceneData) {
      try {
        const scene = JSON.parse(m.sceneData);
        if (scene?.location) line = `[SCENE: ${scene.location} | PRESENT: ${(scene.present ?? []).join(", ")}]\n${line}`;
        for (const name of [...(Array.isArray(scene?.present) ? scene.present : []), ...(Array.isArray(scene?.presentUnaware) ? scene.presentUnaware : [])]) {
          if (typeof name === "string" && name.trim()) presentNames.add(name.trim());
        }
      } catch {}
    }
    return line;
  }).join("\n\n");
  return { text, presentNames: [...presentNames] };
}

/** Every enabled entry as a 120-character snippet (duplicate prevention). */
export function renderExistingEntriesSummary(entries: ReadonlyArray<{ id: string; name: string; tag: string | null; content: string }>): string {
  return entries.map(e => {
    const snippet = e.content.length > 120 ? e.content.slice(0, 120) + "..." : e.content;
    return `- id=${e.id} | name=${e.name}${e.tag ? ` | tag=${e.tag}` : ""}\n  ${snippet}`;
  }).join("\n");
}

/** Entries shown with their complete text. */
export function renderFullEntries(list: ReadonlyArray<{ id: string; name: string; content: string }>): string {
  return list.map(e => `- id=${e.id} | name=${e.name}\n<content>\n${e.content}\n</content>`).join("\n");
}

/** The coverage contract's section: the appeared character entries in full, or "" when none. */
export function renderAppearedSection(list: ReadonlyArray<{ id: string; name: string; content: string }>): string {
  return list.length > 0
    ? `\n\n<appeared_character_entries_full>\n${renderFullEntries(list)}\n</appeared_character_entries_full>`
    : "";
}

type StaleCandidate = { id: string; name: string; tag: string | null; content: string; updatedAt?: string | null; createdAt: string };

/** The stale review's batch: never-delivered rows first (events, then lore,
 *  then the rest), then by the turn this session last delivered them; rows no
 *  session delivered that were edited within 7 days wait (archival's idle
 *  guard). */
export function selectStaleReviewBatch<T extends StaleCandidate>(
  entries: readonly T[],
  thisSession: ReadonlyMap<string, number | null>,
  campaign: ReadonlyMap<string, CampaignActivationEvidence>,
  now: number,
  limit = 100,
): Array<{ entry: T; delivery: DeliveryEvidence; neverActivated: boolean; lastTurn: number | null }> {
  const enriched = entries
    .map(e => {
      const delivery = deliveryEvidence(e.id, thisSession, campaign);
      return { entry: e, delivery, neverActivated: delivery.kind === "never", lastTurn: delivery.kind === "this-session" ? delivery.turn : null };
    })
    .filter(x => !x.neverActivated || idleMs(x.entry, now) >= NEVER_DELIVERED_IDLE_MS);
  enriched.sort((a, b) => {
    if (a.neverActivated !== b.neverActivated) return a.neverActivated ? -1 : 1;
    const tagOrder = (t: string | null) => t === "events" ? 0 : t === "lore" ? 1 : 2;
    if (a.neverActivated && b.neverActivated) return tagOrder(a.entry.tag) - tagOrder(b.entry.tag);
    return (a.lastTurn ?? 0) - (b.lastTurn ?? 0);
  });
  return enriched.slice(0, limit);
}

/** The <stale_review> section for a batch, or "" when it is empty. */
export function renderStaleReview(batch: ReadonlyArray<{ entry: StaleCandidate; delivery: DeliveryEvidence; neverActivated: boolean }>, turnNumber: number): string {
  if (batch.length === 0) return "";
  const lastLabel = (delivery: DeliveryEvidence) => delivery.kind === "this-session" ? String(delivery.turn)
    : delivery.kind === "other-session" ? otherSessionsLabel(delivery.sessions) : "never";
  const lines = batch.map(({ entry: e, delivery, neverActivated }) =>
    `- id=${e.id} | name=${e.name} | tag=${e.tag ?? "none"} | never_activated=${neverActivated} | last_activated_turn=${lastLabel(delivery)}\n  content: ${e.content}`
  ).join("\n");
  return `\n\n<stale_review>\ncurrent_turn=${turnNumber}\n${lines}\n</stale_review>`;
}

/** A model's `known_by` as stored: normalized by the shared helper, null
 *  when nothing is left (common knowledge, as `[]` already rendered). */
export function storedKnownBy(value: unknown): string | null {
  const normalized = normalizeKnownBy(value);
  return normalized.knownBy ? JSON.stringify(normalized.knownBy) : null;
}

/** The main call's user message. */
export function buildDiffUserPrompt(parts: { existingSummary: string; appearedSection: string; recentTurns: string; staleSection: string }): string {
  return `<existing_relevant_entries>\n${parts.existingSummary || "(none)"}\n</existing_relevant_entries>${parts.appearedSection}\n\n<recent_turns>\n${parts.recentTurns}\n</recent_turns>${parts.staleSection}`;
}

/** The main call's system prompt (the stale-review addendum on sweep runs). */
export function rollingDiffSystemPrompt(staleSweep: boolean): string {
  return staleSweep ? ROLLING_DIFF_SYSTEM + STALENESS_ADDENDUM : ROLLING_DIFF_SYSTEM;
}

/** The ops in a reply, and whether it was a parse miss: a non-empty reply with
 *  no JSON array, or an array whose elements all lack an `op`. `[]` (or only
 *  NOOPs) is an answer, not a miss. Exported for tests. */
export function parseDiffOps(text: string): { ops: DiffOp[] | null; miss: boolean } {
  const parsed = parseFirstJson<unknown>(text, "[");
  if (!Array.isArray(parsed)) return { ops: null, miss: text.trim().length > 0 };
  const ops = parsed.filter((op: any) => op && typeof op.op === "string") as DiffOp[];
  return { ops, miss: parsed.length > 0 && ops.length === 0 };
}

/** Why a reply yielded no ops, for the evidence: the extractor
 *  returns no error of its own, so this reproduces the likeliest one. */
export function describeOpsParseMiss(text: string): string {
  const start = text.indexOf("[");
  if (start < 0) return "no JSON array in the reply";
  const end = text.lastIndexOf("]");
  if (end < start) return `a JSON array opens at character ${start} and never closes (the reply may be cut off)`;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(parsed)) return parsed.length === 0 ? "an empty array" : `the array's ${parsed.length} element(s) carry no "op" field`;
    return "the bracketed text is not an array";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What an event keeps of a reply: its length, the first
 *  and last 1,000 characters and, for a reply that yielded no ops, the parse
 *  error (null for one that parsed). */
export function replyEvidence(text: string, miss = true): { responseLen: number; head: string; tail: string; parseError: string | null } {
  return { responseLen: text.length, head: text.slice(0, 1000), tail: text.slice(-1000), parseError: !miss ? null : text.trim() ? describeOpsParseMiss(text) : "empty reply" };
}

/** The scoped re-ask's addition to the original request. */
export function formatCorrectionBlock(parseError: string): string {
  return `\n\n<format_correction>\nYour previous reply to this request could not be read as a JSON array of operations (${parseError}). Reply with only the JSON array of operations that the system prompt describes, with no prose before or after it and no code fences. An empty array is a valid answer when these turns change nothing.\n</format_correction>`;
}

export class RollingDiffWorker {
  private readonly logger = createLogger("rolling-diff-worker");
  private readonly lorebook;
  private readonly campaigns;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;
  private readonly db: DatabaseClient["db"];

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.db = db;
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.campaigns = new CampaignRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    const providers = buildEmbeddingProviders(this.runtimeDefaults);
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    // Scoped revision context: restored after the run settles.
    return this.lorebook.withRevisionContext({ source: "rolling_diff", pipelineRunId: run.id }, () => this.executeInContext(run, signal));
  }

  private async executeInContext(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const now = new Date().toISOString();
    // Passes whose writes have committed: a cancel or a failure after
    // one of them leaves those writes standing, and the event says so.
    const committed: DiffPassRecord[] = [];
    let passCount = 0;
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }

      const sessionId = run.sessionId;
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for rolling diff", null); return; }
      // Player-character names for presence resolution (never another entry's alias).
      const playerNames = sessionPlayerNames(this.sessions.findById(run.userId, sessionId)?.contextOverridesJson);

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as RollingDiffRunDetails : {};
      // The queue stamps the SESSION dial (pipelineQueueService threads
      // `embeddingModel` through detailsJson) — this worker embeds under the
      // same model retrieval reads. The fallback for a run enqueued without it
      // is the API's newest-session rule (embedModelResolver), never a fossil.
      const embedModelId = details.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);
      const isStaleSweep = details.staleSweep === true;

      // The span: every settled message after the point the
      // previous diff of this session reached, read in passes. This run's own
      // marker wins when it resumes after a restart; a session's first diff, or
      // the first after legacy runs without a marker, reads the old window.
      const allMessages = inputs.readSession(sessionId).filter(m => m.role !== "cold-start");
      const readAt = new Date().toISOString();
      const ownMarker = readCoverageMarker(details);
      const previous = ownMarker ?? latestCoverageMarker(this.db, { userId: run.userId, campaignId: run.campaignId, sessionId, kind: "rolling_diff", excludeRunId: run.id });
      const span = selectSpan(allMessages, previous, DIFF_FALLBACK_WINDOW);
      const passes = planPasses(span.rows, DIFF_PASS_CAPS, (row) => renderDiffWindow([row]).text.length);
      passCount = passes.length;
      const earlierPasses = ownMarker && Array.isArray(details.passes) ? details.passes : [];
      if (passes.length === 0) {
        // Nothing settled since the previous diff: no model call. A stale sweep
        // waits for the next run that has turns to read.
        completeRun(this.runs, run.id, now, "No new settled messages since the previous rolling diff", JSON.stringify({
          ops: 0, applied: 0, spanMode: span.mode, passes: earlierPasses, ...(isStaleSweep ? { staleSweepSkipped: true } : {}),
          ...(previous ? { coveredFromSortOrder: details.coveredFromSortOrder ?? null, coveredThroughSortOrder: previous.throughSortOrder, coveredReadAt: readAt } : {}),
        }));
        return;
      }
      const coveredFromSortOrder = ownMarker && Number.isInteger(details.coveredFromSortOrder) ? details.coveredFromSortOrder! : passes[0]![0]!.sortOrder;

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // An unresolvable rollingModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "rolling_diff", "rolling diff", details.rollingModel, getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      // Engine dial (2026-09-09): OpenAI fast mode where the resolved model supports it.
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      let diffInputTokens = 0, diffOutputTokens = 0;
      /** One model call of this run at the run's model, effort and speed; the
       *  usage adds up across calls and passes. */
      const callModel = async (label: string, requestId: string, systemPrompt: string, content: string): Promise<string> => {
        let text = "";
        this.runs.heartbeat(run.id);
        await withDeadline(WORKER_LLM_DEADLINE_MS, label, (dl) => withRetry(() => runtime.streamChat({
          modelId,
          systemPrompt,
          messages: [{ role: "user", content, attachments: [] }],
          temperature: 0,
          thinkingMode: workerThinkingModeFor(modelId, workerEffort),
          thinkingBudget: null,
          effort: workerEffort,
          cacheTtl: "off",
          speed,
          requestId,
          signal: dl,
        }, {
          onStart: () => {},
          onDelta: (delta) => { text += delta; },
          onThinkingDelta: () => {},
          onComplete: (result) => {
            diffInputTokens += result.usage.inputTokens ?? 0;
            diffOutputTokens += result.usage.outputTokens ?? 0;
          },
        }), () => { text = ""; }, signal), signal);
        return text;
      };
      const isAbort = (error: unknown) => signal?.aborted || (error instanceof Error && error.name === "AbortError");

      // Budgets and totals are per run, across its passes.
      let blindReauthorsLeft = BLIND_REAUTHOR_MAX_PER_RUN;
      let sizeFollowUpsLeft = SIZE_GOVERNOR_MAX_FOLLOWUPS;
      const keyCaps = new KeyCapNotes();
      const totals = { ops: 0, applied: 0, held: [] as HeldOp[], heldBlind: [] as string[], heldBlindPastBudget: [] as string[], required: 0, uncovered: 0, uncoveredNames: [] as string[], coverageRetried: false, parseSuspect: false, reasked: false };

      for (const [passIndex, passRows] of passes.entries()) {
        const isLast = passIndex === passes.length - 1;
        // Request ids keep their old form on a single-pass run.
        const tag = passes.length > 1 ? `-pass${passIndex + 1}` : "";
        const window = renderDiffWindow(passRows);
        const recentTurns = window.text;
        const presentNames = new Set(window.presentNames);

        // Each pass reads the lorebook afresh, so it sees the writes of the
        // passes before it.
        const existingEntries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId);
        const existingSummary = renderExistingEntriesSummary(existingEntries);

        // Coverage-contract inputs: FULL content for the character entries these
        // turns touched. The model cannot safely revise what it cannot see — the
        // 120-char snippets above exist for duplicate prevention, and demanding
        // character upkeep against them would force blind full-replacement rewrites
        // (the entry-gutting hazard this block exists to close).
        const appearedIds = detectAppearedCharacterEntries({
          entries: existingEntries,
          windowText: recentTurns,
          presentNames: [...presentNames],
          playerNames,
        });
        const entryById = new Map(existingEntries.map(e => [e.id, e]));
        const appearedFull = appearedIds.flatMap(id => { const e = entryById.get(id); return e ? [e] : []; });
        const appearedSection = renderAppearedSection(appearedFull);

        // The stale review rides the last pass: it concerns the lorebook, not
        // the span, and the last pass sees every earlier pass's writes.
        const staleReview = isStaleSweep && isLast;
        let staleSection = "";
        let staleBatchIds: string[] = [];
        if (staleReview) {
          const staleEntries = this.lorebook.listForCampaign(run.userId, run.campaignId, {
            isEnabled: true, isConstant: false, sort: "last_reviewed_at", order: "asc", limit: 500,
          }).filter(e => !e.compressedRefIds);
          const activationState = this.lorebook.getActivationState(sessionId);
          const activationMap = new Map(activationState.map(s => [s.entryId, s.lastActivatedTurn]));
          // Delivery in any session of the campaign counts: "never" used to
          // mean "never in this session", so a new session saw every event the
          // earlier ones delivered as never activated.
          const campaignEvidence = this.lorebook.findCampaignActivationEvidence(run.userId, run.campaignId, staleEntries.map((e) => e.id));
          // Same scale as the engine's `lastActivatedTurn`.
          const turnNumber = workerTurnNumber(this.messages, run.userId, sessionId, inputs.source);
          const batch = selectStaleReviewBatch(staleEntries, activationMap, campaignEvidence, Date.now());
          staleBatchIds = batch.map(b => b.entry.id);
          staleSection = renderStaleReview(batch, turnNumber);
        }

        const userPrompt = buildDiffUserPrompt({ existingSummary, appearedSection, recentTurns, staleSection });
        const systemPrompt = rollingDiffSystemPrompt(staleReview);
        const responseText = await callModel("rolling-diff model call", `rolling-diff-${run.id}${tag}`, systemPrompt, userPrompt);
        // No-silent-failures: a non-empty response with no readable ops is a parse
        // miss (prose, refusal, invalid or cut-off JSON). A model that legitimately
        // returns `[]` (genuine NOOP) is an answer and must NOT be flagged; that
        // was a false-positive streak of warnings on quiet turns.
        const firstParse = parseDiffOps(responseText);
        let parseSuspect = firstParse.miss;
        let ops = firstParse.ops ?? [];
        if (parseSuspect) {
          // One scoped re-ask: the same request with a
          // format correction, before accepting zero ops. The event keeps enough
          // of both replies to diagnose (it used to keep a 200-character head).
          const first = replyEvidence(responseText);
          const firstError = first.parseError ?? "unreadable reply";
          let retryText = "";
          let retryError: string | null = null;
          try {
            retryText = await callModel("rolling-diff format re-ask", `rolling-diff-reask-${run.id}${tag}`, systemPrompt, `${userPrompt}${formatCorrectionBlock(firstError)}`);
          } catch (error) {
            if (isAbort(error)) throw error;
            retryError = error instanceof Error ? error.message : String(error);
          }
          totals.reasked = true;
          const retry = parseDiffOps(retryText);
          if (retry.ops !== null && !retry.miss) { ops = retry.ops; parseSuspect = false; }
          recordSystemEvent({
            userId: run.userId, source: "rolling_diff", severity: parseSuspect ? "warn" : "info",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: parseSuspect
              ? "rolling diff produced 0 ops from a non-empty model response, and a scoped re-ask did not parse either — nothing from this window was applied; both replies are in the details"
              : `rolling diff's reply could not be parsed; a scoped re-ask returned ${ops.length} operation(s), which were used`,
            details: { runId: run.id, pass: passIndex + 1, ...first, reask: retryError ? { error: retryError } : replyEvidence(retryText, retry.ops === null || retry.miss) },
          });
        }
        if (parseSuspect) totals.parseSuspect = true;
        // Coverage contract (the tracker's validateTrackerDelta discipline, adapted):
        // every appeared character entry must be explicitly accounted for. One SCOPED
        // follow-up call rather than a whole-output reject — the diff's ops are
        // independent per-entry writes, and discarding good CREATEs because one
        // character went unmentioned would trade a stale entry for lost canon.
        // Residual gaps end in a loud system_event, never silence.
        const requiredIds = appearedFull.map(e => e.id);
        // A DISABLE the diff may not apply is held at apply and covers nothing.
        const diffMayDisable = (id: string) => { const e = entryById.get(id); return !!e && workerDisableRefusal(e, "rolling_diff") === null; };
        let uncovered = parseSuspect ? [] : findUncoveredCharacterIds(ops, requiredIds, diffMayDisable);
        if (uncovered.length > 0) {
          totals.coverageRetried = true;
          const followUpEntries = uncovered.flatMap(id => { const e = entryById.get(id); return e ? [e] : []; });
          const followUpPrompt = `Your previous pass did not account for these appeared characters. For EACH entry below emit exactly one operation: an UPDATE (a careful revision of the full content shown — preserve everything still true, fold in the recent turns' developments, maintain the dated CURRENT STATE section) or {"op":"CHARACTER_UNCHANGED","entry_id":"..."}. Output ONLY a JSON array.\n\n<appeared_character_entries_full>\n${renderFullEntries(followUpEntries)}\n</appeared_character_entries_full>\n\n<recent_turns>\n${recentTurns}\n</recent_turns>`;
          let followText = "";
          try {
            followText = await callModel("rolling-diff coverage follow-up", `rolling-diff-coverage-${run.id}${tag}`, ROLLING_DIFF_SYSTEM, followUpPrompt);
          } catch (err) {
            if (isAbort(err)) throw err;
            // Best-effort: a dead follow-up lands in the residue warning below.
          }
          const followOps = (this.parseOps(followText) ?? []).filter((op) =>
            op.entry_id !== undefined && uncovered.includes(op.entry_id)
            && (op.op === "UPDATE" || op.op === "CHARACTER_UNCHANGED" || op.op === "DISABLE"));
          ops.push(...followOps);
          uncovered = findUncoveredCharacterIds(ops, requiredIds, diffMayDisable);
        }
        const uncoveredNames = uncovered.map(id => entryById.get(id)?.name ?? id);
        if (uncovered.length > 0) {
          recordSystemEvent({
            userId: run.userId, source: "rolling_diff", severity: "warn",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `rolling diff left ${uncovered.length} appeared character entr${uncovered.length === 1 ? "y" : "ies"} unaccounted for after a retry: ${uncoveredNames.join(", ")} — their CURRENT STATE may be stale`,
            details: { entryIds: uncovered },
          });
        }
        // Every full replacement must be authored against the complete source.
        // Preserve the initial source version: an owner edit during this follow-up
        // must hold the candidate, never get folded into an older proposal blindly.
        const fullIds = new Set([...appearedIds, ...staleBatchIds, ...existingEntries.filter((e) => e.content.length <= 120).map((e) => e.id)]);
        // Blind UPDATEs (targets the model saw only as a snippet) are re-authored
        // against the full source, one call each, in op order; at most
        // BLIND_REAUTHOR_MAX_PER_RUN per run, across its passes (a run with
        // many blind UPDATEs used to make one sequential 30-minute-deadline call
        // per op). The rest are held through the same event, existing canon
        // untouched.
        const blindIndices = ops.flatMap((op, index) => (op.op === "UPDATE" && op.entry_id && !fullIds.has(op.entry_id)
          // Not an enabled entry of this campaign (missing, foreign, disabled):
          // there is no source to re-author against, and applyOps holds the op
          // with its own reason. It used to be reported here as "without
          // a valid full-source revision".
          && entryById.has(op.entry_id) ? [index] : []));
        const heldBlind: string[] = [];
        const heldBlindPastBudget: string[] = [];
        const dropIndices = new Set<number>();
        for (const index of blindIndices) {
          const op = ops[index]!;
          if (blindReauthorsLeft <= 0) { heldBlindPastBudget.push(op.entry_id!); dropIndices.add(index); continue; }
          blindReauthorsLeft--;
          const source = entryById.get(op.entry_id!)!;
          let replacement: DiffOp | undefined;
          try {
            const text = await callModel("rolling-diff full-source authoring", `rolling-diff-full-source-${run.id}${tag}-${source.id}`, ROLLING_DIFF_SYSTEM,
              `Re-author this proposed UPDATE using the FULL source below. Preserve every still-true fact. Output one UPDATE for this exact entry_id, or NOOP when no correction is justified.\n<proposal>${JSON.stringify(op)}</proposal>\n<full_source id="${source.id}">\n${source.content}\n</full_source>\n<recent_turns>\n${recentTurns}\n</recent_turns>`);
            const candidates = this.parseOps(text);
            replacement = candidates?.find((candidate) => candidate.op === "UPDATE" && candidate.entry_id === source.id && typeof candidate.content === "string" && candidate.content.trim());
            if (!replacement && candidates?.some((candidate) => candidate.op === "NOOP")) { dropIndices.add(index); continue; }
          } catch (error) {
            if (isAbort(error)) throw error;
          }
          if (replacement) ops[index] = replacement;
          else { heldBlind.push(op.entry_id!); dropIndices.add(index); }
        }
        for (const index of [...dropIndices].sort((a, b) => b - a)) ops.splice(index, 1);
        if (heldBlind.length + heldBlindPastBudget.length > 0) {
          const total = heldBlind.length + heldBlindPastBudget.length;
          const parts = [
            ...(heldBlind.length > 0 ? [`${heldBlind.length} without a valid full-source revision`] : []),
            ...(heldBlindPastBudget.length > 0 ? [`${heldBlindPastBudget.length} past this run's budget of ${BLIND_REAUTHOR_MAX_PER_RUN} full-source re-authors`] : []),
          ];
          recordSystemEvent({ userId: run.userId, source: "rolling_diff", severity: "warn", campaignId: run.campaignId, sessionId: run.sessionId,
            message: `rolling diff held ${total} UPDATE(s) (${parts.join("; ")}) — existing canon preserved`,
            details: { entryIds: [...heldBlind, ...heldBlindPastBudget], invalid: heldBlind, pastBudget: heldBlindPastBudget, reauthorBudget: BLIND_REAUTHOR_MAX_PER_RUN } });
        }
        // Size governor follow-ups (2026-09-25): see findOversizeOps. The first
        // SIZE_GOVERNOR_MAX_FOLLOWUPS oversize ops of the run get a re-author
        // call; every one past that budget is applied as written and named in
        // the same warn (a fourth oversize op used to land over the cap
        // in silence).
        const oversizeAll = findOversizeOps(ops, (id) => entryById.get(id)?.tag);
        const oversize = oversizeAll.slice(0, Math.max(0, sizeFollowUpsLeft));
        sizeFollowUpsLeft -= oversize.length;
        const opLabel = (op: DiffOp) => op.op === "CREATE" ? `CREATE "${op.name ?? "(unnamed)"}"` : `UPDATE ${op.entry_id} ("${entryById.get(op.entry_id!)?.name ?? op.entry_id}")`;
        // Labelled before the follow-ups run: a follow-up replaces only its own
        // index and appends companions, so these indices stay valid, but the label
        // must describe the op as the model first wrote it.
        const pastBudget = oversizeAll.slice(oversize.length).map((item) => `${opLabel(ops[item.index]!)} ${item.length} chars (cap ${item.cap})`);
        const stillOversize: string[] = [];
        for (const item of oversize) {
          const op = ops[item.index]!;
          const label = opLabel(op);
          const instruction = item.tag === "characters"
            ? `MOVE the oldest settled HISTORICAL sections VERBATIM into a companion events entry named "<Character> — <arc> Records (<dates>)" (a CREATE in the same output, keys = arc-specific terms from the moved text, never the character's own name or the core entry's keys; up to ${COMPANION_ENTRY_MAX_CHARS} characters), keep the character entry to identity, voice, capabilities, relationships and the dated CURRENT STATE, and leave a one-line pointer to the records.`
            : `SPLIT it into two or more events records (this op keeps its name/entry_id with the first part; companion CREATEs carry the rest, each under ${item.cap} characters, each part keyed on the distinctive terms of its own text rather than a copy of the whole entry's keys, so the parts do not always load together). Nothing is summarized away.`;
          const followUpPrompt = `SIZE GOVERNOR: your ${label} would leave the entry at ${item.length} characters; the cap for "${item.tag}" entries is ${item.cap}. Re-author it under the cap. ${instruction}\nOutput ONLY a JSON array: the replacement ${op.op} for this exact ${op.op === "CREATE" ? "name" : "entry_id"} plus any companion CREATEs.\n\n<oversize_op>\n${JSON.stringify(op)}\n</oversize_op>`;
          let text = "";
          try {
            text = await callModel("rolling-diff size-governor follow-up", `rolling-diff-size-governor-${run.id}${tag}-${item.index}`, ROLLING_DIFF_SYSTEM, followUpPrompt);
          } catch (error) {
            if (isAbort(error)) throw error;
          }
          const candidates = this.parseOps(text) ?? [];
          const replacement = candidates.find((c) => c.op === op.op && typeof c.content === "string" && c.content.trim()
            && (op.op === "CREATE" ? c.name === op.name : c.entry_id === op.entry_id));
          if (replacement && replacement.content!.length <= item.cap) {
            ops[item.index] = replacement;
            const companions = candidates.filter((c) => c !== replacement && c.op === "CREATE" && typeof c.content === "string" && c.content.trim() && c.name && c.content.length <= COMPANION_ENTRY_MAX_CHARS);
            ops.push(...companions);
          } else {
            stillOversize.push(`${label} ${item.length} chars (cap ${item.cap})`);
          }
        }
        if (stillOversize.length + pastBudget.length > 0) {
          const total = stillOversize.length + pastBudget.length;
          const parts = [
            ...(stillOversize.length > 0 ? [`${stillOversize.length} still over after a re-author follow-up`] : []),
            ...(pastBudget.length > 0 ? [`${pastBudget.length} past this run's budget of ${SIZE_GOVERNOR_MAX_FOLLOWUPS} follow-ups`] : []),
          ];
          recordSystemEvent({ userId: run.userId, source: "rolling_diff", severity: "warn", campaignId: run.campaignId, sessionId: run.sessionId,
            message: `rolling diff size governor: ${total} entr${total === 1 ? "y was" : "ies were"} applied over the cap as written (${parts.join("; ")}) — run the lorebook compaction tool`,
            details: { stillOversize: [...stillOversize, ...pastBudget], reAuthoredStillOver: stillOversize, pastBudget, followUpBudget: SIZE_GOVERNOR_MAX_FOLLOWUPS } });
        }
        const sourceVersions = new Map(existingEntries.map((entry) => [entry.id, canonSourceVersion(entry)]));
        // Heartbeat before the synonym phase and (below) before the re-embed:
        // the last beat used to be the one before the main call, so a
        // long diff (main 25 min + synonyms + embed) could cross the 60-min stale
        // sweep while still running.
        this.runs.heartbeat(run.id);
        await this.expandSynonymKeys(runtime, modelId, workerEffort, speed, ops, run.userId, signal, () => this.runs.heartbeat(run.id), keyCaps);
        // Honor a Cancel that landed during the synonym phase: the
        // lorebook must not be mutated under a run the UI already shows as
        // canceled — markCompleted would then no-op against the canceled row and
        // the writes would be invisible to the run history.
        if (signal?.aborted) throw new DOMException("rolling diff canceled before apply", "AbortError");

        totals.ops += ops.length;
        totals.heldBlind.push(...heldBlind);
        totals.heldBlindPastBudget.push(...heldBlindPastBudget);
        totals.required += requiredIds.length;
        if (!parseSuspect) totals.uncovered += uncovered.length;
        totals.uncoveredNames.push(...uncoveredNames);
        const passRecord: DiffPassRecord = { fromSortOrder: passRows[0]!.sortOrder, throughSortOrder: passRows[passRows.length - 1]!.sortOrder, messages: passRows.length, chars: recentTurns.length, ops: ops.length, applied: 0 };
        // Terminal status commits WITH the canon: the
        // completed row and the writes are one transaction, so a cancel that
        // lands after the check above (the API marks the row canceled directly
        // in the split topology; the watcher aborts the signal up to 250 ms
        // later) rolls the writes back instead of leaving live canon under a
        // row that reads "canceled", and an unclean stop can only leave
        // nothing-written + running (requeued and redone) or everything-written
        // + completed (never requeued) — no replay of applied ops. An earlier
        // pass commits its writes with its progress marker instead, so
        // a requeued run continues after the last committed pass rather than
        // replaying it. The re-embed below is best-effort and runs after the
        // commit. Don't rotate the stale-review batch on a parse failure —
        // that silently pushes up to 100 never-reviewed entries to the back of
        // the queue.
        const doneAt = new Date().toISOString();
        const { toEmbed, held: passHeld } = this.applyOps(run.userId, run.campaignId, run.sessionId ?? null, ops, sourceVersions, assertSource, keyCaps, (result) => {
          passRecord.applied = result.applied;
          const coverage = { coveredFromSortOrder, coveredThroughSortOrder: passRecord.throughSortOrder, coveredReadAt: readAt, spanMode: span.mode, passes: [...earlierPasses, ...committed, passRecord] };
          if (!isLast) {
            // A cancel that landed during this pass rolls its writes back here.
            this.recordPassProgress(run, details, coverage);
            return;
          }
          if (staleBatchIds.length > 0 && !parseSuspect) this.lorebook.touchLastReviewedAt(run.userId, staleBatchIds);
          const applied = totals.applied + result.applied;
          const held = [...totals.held, ...result.held];
          const coverageNote = totals.required > 0 && !totals.parseSuspect
            ? `; character coverage ${totals.required - totals.uncovered}/${totals.required}${totals.uncovered > 0 ? ` (unaccounted: ${totals.uncoveredNames.join(", ")})` : ""}`
            : "";
          const passNote = passes.length > 1 ? ` in ${passes.length} passes` : "";
          const completed = this.runs.markCompleted(run.id, doneAt, `Applied ${applied} operations${passNote}${coverageNote}`, JSON.stringify({
            ops: totals.ops, applied, conflicts: held.map((h) => h.entryId), held,
            heldBlind: [...totals.heldBlind, ...totals.heldBlindPastBudget], heldBlindPastBudget: totals.heldBlindPastBudget,
            ...(keyCaps.list().length > 0 ? { keyCaps: keyCaps.list() } : {}),
            parseSuspect: totals.parseSuspect, reasked: totals.reasked,
            characterCoverage: { required: totals.required, uncovered: totals.uncovered, retried: totals.coverageRetried },
            usage: { modelId, inputTokens: diffInputTokens, outputTokens: diffOutputTokens },
            ...coverage,
          }));
          if (!completed) throw new DOMException("rolling diff canceled before its writes committed", "AbortError");
          this.runs.updateRun(run.id, { approvedAt: doneAt });
        });
        committed.push(passRecord);
        totals.applied += passRecord.applied;
        totals.held.push(...passHeld);
        if (toEmbed.length) {
          this.runs.heartbeat(run.id);
          await withTimeout(this.embedding.indexEntries(toEmbed, embedModelId), WORKER_LLM_DEADLINE_MS, "rolling-diff re-embed")
            .catch((err) => {
              // The hung-embed (withTimeout) path is not covered by
              // indexEntries' own provider-error events.
              this.logger.warn({ runId: run.id, count: toEmbed.length, err }, "rolling-diff re-embed failed/timed out — vectors stale until backfill");
              recordSystemEvent({
                userId: run.userId, source: "rolling_diff", severity: "warn",
                campaignId: run.campaignId, sessionId: run.sessionId,
                message: `rolling-diff re-embed failed or timed out for ${toEmbed.length} rewritten entr${toEmbed.length === 1 ? "y" : "ies"} — vectors stale until backfill`,
                details: { runId: run.id, count: toEmbed.length, entryIds: toEmbed.map((e) => e.id), error: err instanceof Error ? err.message : String(err) },
              });
            });
        }
      }
      this.logger.info({ runId: run.id, applied: totals.applied, held: totals.held.length, passes: passes.length }, "rolling diff completed");
    } catch (error) {
      const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
      // Abort ⇒ cancel (not fail). The guarded transitions mean even if the
      // run was already canceled by the watcher, markCanceled is a safe no-op.
      if (aborted) this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
      else this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "rolling diff failed", null);
      if (committed.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "rolling_diff", severity: "info", campaignId: run.campaignId, sessionId: run.sessionId ?? null,
          message: `rolling diff ${aborted ? "was canceled" : "failed"} after ${committed.length} of ${passCount} passes had committed; their writes stand, and the next rolling diff continues after them`,
          details: { runId: run.id, passes: committed },
        });
      }
    }
  }

  /** An intermediate pass's progress marker, written in the pass's
   *  write transaction. A row that is no longer running (the owner canceled it)
   *  aborts the transaction, so the pass's writes roll back with it. */
  private recordPassProgress(run: { id: string; userId: string }, original: RollingDiffRunDetails, coverage: Record<string, unknown>): void {
    const row = this.runs.findById(run.userId, run.id);
    if (!row || row.status !== "running") throw new DOMException("rolling diff canceled between passes", "AbortError");
    this.runs.updateRun(run.id, { detailsJson: JSON.stringify({ ...original, ...coverage }), updatedAt: new Date().toISOString() });
  }

  /** `speed`: the OpenAI fast-mode resolution for this run's model;
   *  every call of the run, not only the main and coverage calls, honors the
   *  Engine dial the provider contract promises for "every pipeline worker". */
  private async expandSynonymKeys(runtime: ChatRuntime, modelId: string, workerEffort: ReturnType<typeof workerEffortFor>, speed: "fast" | undefined, ops: DiffOp[], userId: string, signal?: AbortSignal, heartbeat?: () => void, keyCaps?: KeyCapNotes): Promise<void> {
    const targets: { op: DiffOp; name: string; label: string; content: string; existingKeys: string[] }[] = [];
    for (const op of ops) {
      if (op.op === "CREATE" && op.name && op.content) {
        targets.push({ op, name: op.name, label: op.name, content: op.content, existingKeys: normalizeKeyList(op.keys, { max: Number.MAX_SAFE_INTEGER }).keys });
      } else if (op.op === "UPDATE" && op.entry_id && op.content) {
        const existing = this.lorebook.findById(userId, op.entry_id);
        if (!existing) continue;
        targets.push({ op, name: existing.name, label: `${existing.name} (${op.entry_id})`, content: op.content, existingKeys: parseStoredKeys(existing.keys) });
      }
    }
    if (targets.length === 0) return;

    await Promise.all(targets.map(async ({ op, name, label, content, existingKeys }) => {
      try {
        const prompt = `For the lorebook entry below, generate 5-10 additional keywords that someone might use to reference this content. Include: synonyms, alternate phrasings, related terms, common vocabulary variants. EXCLUDE any word already in the existing keys list. Keep keys short (1-3 words each). Output JSON only: {"keys": ["word1", "word2", ...]}.\n\n<entry_name>${name}</entry_name>\n<existing_keys>${existingKeys.join(", ") || "(none)"}</existing_keys>\n<content_excerpt>${content.slice(0, 400)}</content_excerpt>`;
        let responseText = "";
        heartbeat?.();
        await withDeadline(WORKER_LLM_DEADLINE_MS, "synonym-keys call", (dl) => withRetry(() => runtime.streamChat({
          modelId,
          systemPrompt: "You are a retrieval-keyword generator. Output JSON only, no prose.",
          messages: [{ role: "user", content: prompt, attachments: [] }],
          temperature: 0.3,
          thinkingMode: workerThinkingModeFor(modelId, workerEffort),
          thinkingBudget: null,
          effort: workerEffort,
          cacheTtl: "off",
          speed,
          requestId: `synonym-keys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          signal: dl,
        }, {
          onStart: () => {},
          onDelta: (delta) => { responseText += delta; },
          onThinkingDelta: () => {},
          onComplete: () => {},
        }), () => { responseText = ""; }, signal), signal);
        const match = responseText.match(/\{[\s\S]*"keys"[\s\S]*\}/);
        if (!match) return;
        const parsed = JSON.parse(match[0]) as { keys: unknown };
        if (!Array.isArray(parsed.keys)) return;
        const merged = mergeSynonymKeysDetailed(existingKeys, parsed.keys);
        keyCaps?.noteMerge(label, merged);
        if (merged.added.length > 0) op.keys = merged.keys;
      } catch (err) {
        // A run-cancel must propagate: the main call and the
        // coverage follow-up already do; only a genuine synonym-call failure
        // is graceful (keys left unchanged).
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      }
    }));
  }

  // Returns null when no JSON array could be extracted/parsed (a real parse
  // failure), vs [] when the model legitimately returned an empty array.
  private parseOps(text: string): DiffOp[] | null {
    const parsed = parseFirstJson<unknown>(text, "[");
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((op: any) => op && typeof op.op === "string");
  }

  /** `onApplied` runs INSIDE the write transaction after the last op:
   *  the caller records the run's terminal state there, so canon and status
   *  commit — or roll back — together. It must be synchronous and must not
   *  record system_events (those use the process's other connection). */
  private applyOps(userId: string, campaignId: string, sessionId: string | null, ops: DiffOp[], sourceVersions = new Map<string, string>(), assertSource?: () => void, keyCaps = new KeyCapNotes(), onApplied?: (result: { applied: number; held: HeldOp[] }) => void): { applied: number; toEmbed: { id: string; userId: string; content: string }[]; held: HeldOp[] } {
    const now = new Date().toISOString();
    let applied = 0;
    const toEmbed: { id: string; userId: string; content: string }[] = [];
    const retagged: string[] = [];
    const held: HeldOp[] = [];

    this.lorebook.transact(() => {
      assertSource?.();
      for (const op of ops) {
        if (op.op === "NOOP") continue;
        // Coverage declaration, not a write — counted by the contract, never applied.
        if (op.op === "CHARACTER_UNCHANGED") continue;
        if (op.op !== "CREATE" && op.entry_id) {
          // Each held op carries its own reason: they used to share one
          // "changed or outside this campaign" line whatever the cause.
          const live = this.lorebook.findById(userId, op.entry_id);
          // The shared DISABLE predicate: an archive trigger is
          // never disabled by the diff.
          const disableRefusal = live && (op.op === "DISABLE" || op.op === "DELETE") ? workerDisableRefusal(live, "rolling_diff") : null;
          const reason: HeldOpReason | null = !live ? "not-found"
            : live.campaignId !== campaignId ? "other-campaign"
            : live.isConstant ? "constant"
            : live.tag === "threads" ? "thread"
            : !live.isEnabled ? "disabled"
            : disableRefusal
              ?? (sourceVersions.get(op.entry_id) !== canonSourceVersion(live) ? "source-changed" : null);
          if (reason) {
            held.push({ entryId: op.entry_id, op: op.op, reason });
            continue;
          }
        }

        if (op.op === "CREATE" && op.name && op.content) {
          const id = createId();
          const tag = sanitizeCreateTag(op.tag);
          if (tag.retagged) retagged.push(`${op.name} (${op.tag})`);
          // A Records companion or a split part is keyed off its owner and never chains through
          // recursion (unlinked records, 2026-09-28) — the prompt asks for it, the code enforces it.
          const unlinked = isRecordsOrPartName(op.name);
          // One key rule for every stored list: trimmed, no empties or
          // case repeats, at most LOREBOOK_MAX_KEYS; a binding cap is noted.
          const createKeys = createKeysFor(op.name, op.keys);
          keyCaps.noteList(op.name, createKeys);
          this.lorebook.create({
            id,
            userId,
            campaignId,
            name: op.name,
            tag: tag.tag,
            content: op.content,
            comment: null,
            keys: JSON.stringify(createKeys.keys),
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
            excludeRecursion: unlinked ? 1 : 0,
            preventRecursion: unlinked ? 1 : 0,
            delayUntilRecursion: 0,
            tokensEstimate: estimateTokens(op.content),
            // Bounded like an editor's list: trimmed, deduplicated, names
            // and length capped; an empty list is null (common knowledge).
            knownBy: storedKnownBy(op.known_by),
            matchOptionsJson: null,
            legacySource: null,
            createdAt: now,
            updatedAt: now,
          });
          toEmbed.push({ id, userId, content: op.content });
          applied++;
        }

        if (op.op === "CONFIRM_OFFSCREEN" && op.entry_id) {
          // Witness → graduate (offscreen-flow 2026-07-17): live play showed or
          // referenced the offscreen event, so the provisional marker comes off
          // and it becomes ordinary established canon (keeps its knownBy scope).
          if (confirmOffscreenEntry(this.lorebook, userId, op.entry_id)) applied++;
          continue;
        }

        if (op.op === "UPDATE" && op.entry_id && op.content) {
          const existing = this.lorebook.findById(userId, op.entry_id);
          // Constants (the Thread Index) and tracker-owned threads entries are
          // never valid rolling-diff targets — the prompt forbids it but the
          // code must enforce it (LLM UPDATEs could desync/clobber them).
          if (existing && !existing.isConstant && existing.tag !== "threads") {
            const updates: Record<string, unknown> = {
              content: op.content,
              tokensEstimate: estimateTokens(op.content),
              updatedAt: now,
            };
            if (op.known_by !== undefined) updates.knownBy = storedKnownBy(op.known_by);
            // Keys on an UPDATE are MERGED onto the live list, never a
            // replacement: a model-supplied `keys: ["Ryn"]` used to
            // land verbatim whenever the synonym pass added nothing (failure,
            // no room, all duplicates), discarding the entry's curated keys —
            // the retrieval mechanism. The synonym pass merges too; this is the
            // chokepoint guarantee.
            if (Array.isArray(op.keys) && op.keys.length > 0) {
              // Merged through the shared helper with the diff's growth cap of
              // 20 and the list cap; a binding cap is noted.
              const merged = mergeSynonymKeysDetailed(parseStoredKeys(existing.keys), op.keys);
              keyCaps.noteMerge(`${existing.name} (${op.entry_id})`, merged);
              // A merge never re-links a Records companion or split part to its owner (2026-09-28).
              if (merged.added.length > 0) updates.keys = JSON.stringify(isRecordsOrPartName(existing.name) ? unlinkRecordsKeys(existing.name, merged.keys) : merged.keys);
            }
            this.lorebook.update(userId, op.entry_id, updates as any);
            toEmbed.push({ id: op.entry_id, userId, content: op.content });
            applied++;
          }
        }

        if ((op.op === "DELETE" || op.op === "DISABLE") && op.entry_id) {
          const target = this.lorebook.findById(userId, op.entry_id);
          if (target && !target.isConstant && target.tag !== "threads") {
            this.lorebook.update(userId, op.entry_id, { isEnabled: 0, updatedAt: now } as any);
            applied++;
          }
        }
      }
      onApplied?.({ applied, held });
    });
    if (held.length) recordSystemEvent({ userId, source: "rolling_diff", severity: "info", campaignId, sessionId,
      message: `rolling diff held ${held.length} operation(s): ${describeHeldOps(held)} — the existing entries were kept`,
      details: { entryIds: held.map((h) => h.entryId), held, byReason: countHeldByReason(held) } });
    if (retagged.length > 0) {
      // Visible, not silent: the prompt forbids these tags, so a model that
      // emits one is drifting — the entry was kept as `events`.
      recordSystemEvent({
        userId, source: "rolling_diff", severity: "info", campaignId, sessionId,
        message: `rolling diff CREATE used a reserved tag on ${retagged.length} entr${retagged.length === 1 ? "y" : "ies"} — retagged to "events": ${retagged.join(", ")}`,
        details: { retagged },
      });
    }
    return { applied, toEmbed, held };
  }
}
