import { pipelineInputsForRun, settledSourceForRun, settledEvidence } from "./settledSourceGuard";
import type { PipelineTranscriptInput, PipelineTranscriptManifest } from "../../../api/src/domain/chat/pipelineTranscriptInput";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";
import type { CampaignAuditReport } from "@tracyhill-rp/contracts";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { AuditFindingRepository, fingerprintFinding, type AuditFindingRow } from "../../../api/src/domain/pipeline/auditFindingRepository";
import { listActiveOffscreen, supersedeOffscreenEntry } from "../../../api/src/domain/world/offscreen";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { decodeVector, cosineSimilarity } from "../../../api/src/domain/context/vectorIo";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, withTimeout, WORKER_LLM_DEADLINE_MS, isResumableError, resumeCooldownMs, MAX_RESUME_ATTEMPTS } from "../pipeline/retryHelper";
import { EPISTEMIC_STATUS_RULE, EPISTEMIC_STATUS_VERDICT_RULE } from "./epistemicStatus";
import { stripOocBlocks } from "../../../api/src/domain/context/stripOoc";
import { createId } from "../../../api/src/lib/ids";
import { canonSourceVersion } from "./canonSourceVersion";
import { resolveWorkerModel } from "./workerModel";
import { resolveCampaignEmbedModel } from "../../../api/src/domain/context/embedModelResolver";
import { sanitizeCreateTag } from "../../../api/src/domain/context/lorebookTags";
import { mergeKeyLists, normalizeKeyList } from "../../../api/src/domain/context/lorebookKeys";
import { normalizeKnownBy } from "../../../api/src/domain/context/lorebookKnownBy";
import { KeyCapNotes, type KeyCapNote } from "./keyCapNotes";
import { countHeldByReason, describeHeldOps, type HeldOp } from "./heldOps";
import { workerDisableRefusal } from "./workerDisable";

// Campaign Audit.
// Full-history reconciliation with NO watermarks: every FULL run re-reads the
// transcript from message 1; idempotency comes from diffing against the
// existing lorebook (NOOP-first prompt + duplicate guard + validator), never
// from stored progress. QUICK skips Phase 1 and audits the lorebook against
// itself. Findings auto-apply behind two adversarial passes (refute-first,
// then fix-validation); unverdicted findings degrade to flagged-not-applied.

const CHUNK_MAX_CHARS = 50_000;
// Read-only tail of the next chunk carried into each sweep window (see
// buildLookahead). ~16% overhead on a 50k window; the reframing that changes an
// event's meaning lands within a few messages of it in practice.
const LOOKAHEAD_MAX_CHARS = 8_000;
const CLUSTER_MAX_CHARS = 200_000;
const RELEVANT_ENTRIES_PER_CHUNK = 150;
// Per-entry view in the sweep's <existing_entries> block. 150 entries × 400
// chars keeps the window's overhead bounded; an UPDATE authored against a
// target LONGER than this is re-authored by the refine call with the full
// content in hand (the audit's copy of the rolling diff's `d90d484`
// blind-rewrite fix).
const SWEEP_ENTRY_VIEW_CHARS = 400;
// Preservation passes carry complete sources and candidates. Oversized inputs
// fail visibly at callModel's budget guard instead of clipping away facts.
const REFUTE_BATCH = 12;
const VALIDATE_BATCH = 8;
// Audit calls get their own per-call deadline, NOT the shared 30-min
// WORKER_LLM_DEADLINE_MS: at max reasoning a single 200K-char map cluster
// legitimately runs past 30 minutes. Every audit
// call is input-bounded by design constants (chunk/cluster/reduce-slice caps),
// so campaign size scales the CALL COUNT, never one call's duration — 120 min
// is model-depth headroom, not campaign headroom. Cheap to be generous now the
// audit owns its own lane: the 10-min SSE inactivity gate reaps dead streams,
// during-call heartbeats keep the 60-min stale-lock sweep honest, and the
// codex transport ceiling sits above this so the deadline (resumable,
// checkpointed) is what governs aborts.
const AUDIT_LLM_DEADLINE_MS = 120 * 60_000;
// Wall-clock beat cadence while a call is in flight — see callModel.
const AUDIT_CALL_HEARTBEAT_MS = 45_000;
const DEDUP_SIMILARITY = 0.9;
// Op-class blast-radius caps: cap the DANGEROUS
// ops, never the VOLUMINOUS ones. CREATE is uncapped — coverage is the
// legitimate bulk of a first full run.
const DISABLE_CAP_FLOOR = 10;
const DISABLE_CAP_FRACTION = 0.08;
const UPDATE_CAP_FRACTION = 0.33;

const SWEEP_SYSTEM = `You audit LOREBOOK COVERAGE for a long-form roleplay campaign. You receive one chronological WINDOW of the story transcript plus the existing lorebook entries relevant to it. Most of this history has usually been processed before — your default verdict is NOOP.

Emit a JSON array of operations ONLY for story material the existing entries do not capture, or capture incorrectly:
[
  {"op": "CREATE", "name": "...", "tag": "characters|locations|events|lore|relationships|capabilities|factions|rules|traits", "content": "...", "keys": ["..."], "known_by": ["..."] or null, "basis": "short quote or paraphrase from THIS window that justifies the op"},
  {"op": "UPDATE", "entry_id": "...", "content": "full replacement content", "keys": ["..."] or omit, "known_by": [...] or omit, "basis": "..."},
  {"op": "NOOP"}
]

HARD RULES:
1. NOOP-FIRST. If an entry already covers the topic — even partially or in different words — do NOT create a duplicate; UPDATE it only if this window adds or corrects something substantive.
2. Prefer UPDATE over CREATE whenever a listed entry covers the same character/place/event/fact.
2b. Entries marked [PROPOSED EARLIER THIS AUDIT] are CREATEs this audit already proposed from an earlier window (they do not exist yet). Treat them exactly like existing entries: UPDATE them by their id with a FULL replacement that keeps what the earlier window established and folds this window's material in — never CREATE the same character/place/event again.
3. UPDATE content is a FULL replacement — preserve everything still true from the current content and fold the new material in. Never drop established facts.
4. Every op carries a "basis" grounded in THIS window. No basis, no op.
5. Do not write entries about the mechanics of the roleplay itself (system prompts, dice, the user) — story canon only.
6. known_by: ONLY who in-fiction knows the fact; null = common knowledge.
7. Output ONLY the JSON array. No prose, no fences.
${EPISTEMIC_STATUS_RULE}`;

// Second sweep pass, per window, ONLY for UPDATE ops whose target was shown
// truncated in <existing_entries>. The op's basis + proposed content carry the
// new material, so this call needs the full target, not the window again.
const SWEEP_REFINE_SYSTEM = `You are the second pass of a lorebook coverage sweep. Each numbered item is an UPDATE op that was authored while seeing only the FIRST ${SWEEP_ENTRY_VIEW_CHARS} characters of its target entry. You now receive the target's FULL CURRENT content, plus the op's basis and its proposed content (the new or corrected material).

Re-author each op as a true FULL replacement: reproduce the current content, keep every fact that is still true, fold in what the proposal adds or corrects, and change nothing else. Never summarize, reorder, or drop lines the proposal does not correct. If, with the full content in hand, the entry already carries what the proposal adds, emit NOOP for that index.

Output ONLY JSON: {"ops":[{"index":0,"op":"UPDATE","content":"<full replacement>","keys":["..."] or omit,"known_by":[...] or omit,"basis":"..."},{"index":1,"op":"NOOP"}]} — one entry for EVERY index.
${EPISTEMIC_STATUS_RULE}`;

const MAP_SYSTEM = `You audit a roleplay campaign's LOREBOOK for internal contradictions. You receive one cluster of entries (id, name, tag, full content). Output ONLY JSON:
{
  "contradictions": [
    {"entryIds": ["id1","id2"], "claim": "one line naming the conflict", "detail": "what each entry asserts and why they cannot both be true"}
  ],
  "ledger": [
    {"entity": "Sofia", "claims": [{"text": "sworn fealty to Corin since June 5", "entryId": "id1"}]}
  ]
}
Rules:
1. A contradiction is two entries asserting INCOMPATIBLE facts (dates, states, relationships, outcomes) — not different levels of detail, not nuance split across entries, not evolution over story time when both states are dated.
2. The ledger is a COMPACT index for cross-cluster checking: per entity, the 2-6 load-bearing claims with their source entry id. Skip flavor.
3. rules-tagged entries are NOT exempt: when a rules entry asserts world-state (who knows whom, current schedules or deadlines, capability status) treat those assertions as claims like any other — "permanent" rules that froze an early-campaign state are a known failure class (e.g. a rules entry still calling the protagonist an unknown). Interaction-mechanics text (how the AI writes turns) is out of scope.
4. Report at most 12 contradictions — the sharpest ones. Empty arrays are a valid result.`;

/** The scoped re-ask appended to the same cluster. */
function mapReask(problem: string): string {
  return `Your previous reply to this request could not be used: ${problem}. Reply again with only the JSON object your instructions describe, with the keys "contradictions" and "ledger", for the entries above. Do not add prose or code fences.`;
}

const REDUCE_SYSTEM = `You are the second pass of a lorebook coherence audit. You receive per-cluster ENTITY LEDGERS (entity → claims → source entry ids) from a roleplay campaign's lorebook. Output ONLY JSON:
{
  "contradictions": [{"entryIds": ["id1","id2"], "claim": "...", "detail": "..."}],
  "stale": [{"entryIds": ["id1"], "claim": "why this entry looks outdated/superseded", "detail": "..."}],
  "analysis": "8-20 sentences: the current state of the campaign as the ledgers tell it — active arcs, key relationships, notable inconsistencies or drift you observed, overall lorebook health."
}
Rules:
1. Look for CROSS-cluster conflicts: the same entity carrying incompatible claims from different entries.
2. "stale" = an entry whose claims later claims plainly supersede (not merely older).
3. At most 12 contradictions + 8 stale. Empty arrays are valid. The analysis is always required.`;

const RESOLVE_SYSTEM = `You RESOLVE contradictions in a roleplay campaign's lorebook. You receive one contradiction, the implicated entries' full content, and transcript evidence (the story itself — the most relevant excerpts, in story order; the sole source of truth).

Decide: does the transcript UNAMBIGUOUSLY settle which side is correct?
- YES → author the minimal corrective UPDATE(s): full replacement content for the WRONG entry/entries, changing ONLY what's needed to match the transcript truth and preserving everything else. An entry marked [PROTECTED] can NEVER be an op target (worker-owned) — resolve via the non-protected entries only, or decline.
- NO (two readings both fit; the transcript is silent; the "conflict" is dated story evolution or mere nuance) → DECLINE. Do not guess. A wrong auto-fix is worse than a flag.

Output ONLY JSON:
{"resolved": true, "ops": [{"op":"UPDATE","entry_id":"<one of the implicated ids>","content":"<full corrected content>","basis":"<transcript quote/paraphrase that settles it>"}]}
or {"resolved": false, "reason":"<why the transcript doesn't settle it>"}
${EPISTEMIC_STATUS_RULE}

An entry that already carries correct epistemic framing ("this was a projection", "she believed she had", "the figure appeared to be") is NOT the wrong side of a contradiction merely because an excerpt depicts the event flatly. Correcting such an entry to match the excerpt REVERSES a fix. DECLINE unless the evidence settles which version is the world's truth.`;

const REFUTE_SYSTEM = `You are the ADVERSARIAL VERIFIER of a campaign-audit. Your job is to KILL findings. For each numbered finding you receive the claim, the implicated lorebook entries' ACTUAL content, and transcript evidence (the most relevant excerpts, in story order — the transcript is the sole source of truth; the last excerpt is merely the latest by story order among the hits, not necessarily the story's newest word on the matter).

REFUTE a finding when: the entries are reconcilable readings; the "conflict" is nuance, altitude, or dated story evolution; the transcript evidence does not support it; a proposed coverage op duplicates what an entry already says; or you are UNCERTAIN — when in doubt, refute.
CONFIRM only findings a careful human editor would also fix.
${EPISTEMIC_STATUS_VERDICT_RULE}

Output ONLY JSON: {"verdicts":[{"index":0,"ok":true},{"index":1,"ok":false,"reason":"..."}]} — one verdict for EVERY index you were given.`;

const VALIDATE_SYSTEM = `You are the FIX VALIDATOR of a campaign-audit. Each numbered item is a proposed lorebook operation that survived verification, shown with the target entry's CURRENT content where one exists. REJECT an op when:
1. It would LOSE unique information the current content carries (UPDATE must be a superset of everything still true).
2. It contradicts the other entries shown.
3. Its known_by list is implausible (someone knows what they couldn't).
4. It is redundant — the current content already says this.
5. The CURRENT content may have changed since the op was authored (this is a live campaign — other workers and the owner edit entries while an audit runs): if the current content already resolves the finding, REJECT as redundant; if it carries NEW facts the proposal would drop, emit a fixedOp that merges them.
Otherwise ACCEPT. You may emit a corrected op (e.g. merge the proposed content with dropped facts) as "fixedOp".

Output ONLY JSON: {"verdicts":[{"index":0,"ok":true},{"index":1,"ok":false,"reason":"..."},{"index":2,"ok":true,"fixedOp":{...}}]} — one verdict for EVERY index.`;

const RULING_PLAN_SYSTEM = `You EXECUTE the owner's rulings on flagged campaign-audit findings for a roleplay campaign's lorebook. The owner's ruling is AUTHORITY — translate it into minimal lorebook operations; never re-litigate it.

For each numbered ruling you receive: the original finding (why it was flagged), the implicated entries' CURRENT content, transcript evidence, and the owner's ruling. You also receive a compact catalog of every entry (id | name | tag | keys).

Decide per ruling:
- action "ops": you can implement it. List EVERY entry id whose full current content you need (targetEntryIds) — the implicated entries plus any catalog entries the ruling's scope reaches (a "propagate everywhere X" ruling means every entry whose name/tag/keys suggest it carries the fact). Do NOT author content in this pass; it arrives in a second call.
- action "clarify": the ruling is too vague or self-contradictory to implement safely. Ask ONE specific question. Never guess.

Rules:
1. A leave-it-alone / it's-intentional ruling still gets action "ops": plan a minimal canon-note — one bracketed line appended to the most relevant entry (e.g. "[Canon note — owner ruling: the rumor deliberately predates the resurrection.]") so future audits stop re-flagging the same tension.
2. The story transcript can NEVER be edited — corrections live in lorebook entries that supersede it.
3. Entries marked [PROTECTED] (constants / tracker-owned threads) are never targets.
4. targetEntryIds must come from ids you were shown. At most 30 per ruling.

Output ONLY JSON: {"plans":[{"index":0,"action":"ops","targetEntryIds":["..."],"intent":"one line"},{"index":1,"action":"clarify","question":"..."}]} — one plan for EVERY index.`;

const RULING_EXECUTE_SYSTEM = `You are the second pass of a ruling execution for a roleplay campaign's lorebook. For each numbered ruling you receive the finding, the owner's ruling (AUTHORITY), your planned intent, and the FULL CURRENT content of every target entry. Author the final operations.

Rules:
1. UPDATE content is a FULL replacement: change only what the ruling requires and preserve everything else still true.
2. The ruling decides what is true. Where it corrects a fact, propagate the correction across every target entry that carries the wrong version. Where it declares intent (leave-as-is / intentional), append one short bracketed canon-note line to the most relevant entry instead of rewriting.
2b. LONG ENTRIES: for any entry over a few paragraphs (rosters, compendia), reproduce the ENTIRE current content VERBATIM and change only the minimal spans the ruling requires — never summarize, reorder, or drop lines. If you cannot reproduce it faithfully, decline with a clarify question instead of guessing.
3. Allowed ops: UPDATE (entry_id from the targets), CREATE (only when the ruling establishes a fact no existing entry can carry), DISABLE (only when the ruling says an entry is wrong wholesale). Never DELETE.
4. known_by changes only when the ruling affects who knows what.
5. Every op carries a "basis" quoting the ruling.
6. If, with the full content in hand, an entry already reflects the ruling, emit no op for it.

Output ONLY JSON: {"results":[{"index":0,"ops":[{"op":"UPDATE","entry_id":"...","content":"...","basis":"owner ruling: ..."}],"outcome":"one line: what you did and why"}]} — one result for EVERY index.`;

const OFFSCREEN_COHERENCE_SYSTEM = `You reconcile a roleplay campaign's OFFSCREEN EVENT LEDGER — background events generated by repeated world simulation. The transcript is IRRELEVANT here (these events never appear in it, by design). The source of truth is the ledger's own timeline: when two entries cover the SAME underlying fact, the NEWEST entry is the current truth.

The ledger below is newest-first. Known failure modes you are cleaning: the simulator re-generated the same fact multiple times (near-duplicate entries), and sometimes REGRESSED a fact (an older entry shows a state the newer one un-does — the newer entry still wins).

Output ONLY JSON: {"ops":[
  {"op":"SUPERSEDE","entry_id":"<older duplicate/stale variant>","by":"<the newest entry for that fact>","reason":"one line"},
  {"op":"MERGE","keep_id":"<newest entry>","absorb_ids":["<older entries>"],"content":"full replacement content for keep_id folding in any unique detail the older entries carry","reason":"one line"},
  {"op":"FLAG","entry_ids":["..."],"claim":"one line","detail":"why these describe genuinely DIFFERENT irreconcilable facts (rare — newest-wins settles same-fact conflicts)"}
]}
Rules:
1. SUPERSEDE when the older entry adds nothing the newest lacks; MERGE when older entries carry unique detail worth keeping (content is a FULL replacement for keep_id — preserve everything still true).
2. Never SUPERSEDE/absorb the newest entry of a fact. keep_id must be the newest of its group.
3. Entries about DIFFERENT facts are fine side by side — do not force merges.
4. FLAG is a last resort. Empty ops is a valid answer for a clean ledger.`;

export interface AuditOp {
  op: "CREATE" | "UPDATE" | "DISABLE" | "DELETE" | "NOOP";
  entry_id?: string;
  name?: string;
  tag?: string;
  content?: string;
  keys?: string[];
  known_by?: string[] | null;
  basis?: string;
  // Optimistic-concurrency stamp: the target's updatedAt as the
  // VALIDATOR saw it. applyOps compare-and-swaps against it — a mismatch means
  // the entry changed underneath the audit (fast-lane job, user edit) and the
  // op goes through ONE re-validation round instead of clobbering fresh canon.
  expected_updated_at?: string;
  expected_source_versions?: Record<string, string>;
}

export interface AuditFinding {
  kind: "coverage" | "contradiction" | "stale";
  summary: string;
  detail?: string;
  entryIds?: string[];
  op?: AuditOp;
  basis?: string;
  // Run-scoped id of a pending CREATE: later sweep windows see the
  // proposal under this id and UPDATE it instead of creating the entity again.
  pendingId?: string;
}

/** A sweep-time fold of a later op into a pending CREATE: the
 *  finding is replaced in place, never a second CREATE. Exported for tests. */
export function foldIntoPendingCreate(pending: AuditFinding, op: AuditOp): void {
  const target = pending.op;
  if (!target || target.op !== "CREATE") return;
  if (typeof op.content === "string" && op.content.trim()) target.content = op.content;
  if (Array.isArray(op.keys) && op.keys.length > 0) target.keys = unionKeysCaseInsensitive(target.keys ?? [], op.keys);
  if (op.known_by !== undefined) target.known_by = op.known_by;
  if (op.basis) target.basis = target.basis ? `${target.basis} | ${op.basis}` : op.basis;
  pending.basis = target.basis;
  pending.detail = coverageDetail(target);
}

function unionKeysCaseInsensitive(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of [...a, ...b]) {
    const k = String(key).trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

/** Tail-side safety net: CREATE findings that name the same entity as
 *  an EARLIER window's CREATE (exact normalized name or key overlap — the same
 *  `nearestByNameKeys` rule used against live entries) fold into the first:
 *  keys and known_by merge (null wins for known_by — global stays global), the
 *  longer content is kept (windows are chronological, so the later CREATE is
 *  usually the fuller restatement; the primary path is rule 2b, where the model
 *  folds deliberately). Returns the folded findings with a reason so the report
 *  lists them under `refuted` — nothing silently dropped. Exported for tests. */
export function foldSiblingCreates(findings: AuditFinding[]): Array<{ finding: AuditFinding; into: AuditFinding; reason: string }> {
  const kept: Array<{ id: string; name: string; keys: string; finding: AuditFinding }> = [];
  const folded: Array<{ finding: AuditFinding; into: AuditFinding; reason: string }> = [];
  for (const finding of findings) {
    const op = finding.op;
    if (!op || op.op !== "CREATE" || !op.name || !op.content) continue;
    const near = nearestByNameKeys(kept, { name: op.name, keys: op.keys });
    if (!near) { kept.push({ id: finding.pendingId ?? `create:${kept.length}`, name: op.name, keys: JSON.stringify(op.keys ?? []), finding }); continue; }
    const first = near.finding.op!;
    first.keys = unionKeysCaseInsensitive(first.keys ?? [], op.keys ?? []);
    first.known_by = first.known_by == null || op.known_by == null ? null : unionKeysCaseInsensitive(first.known_by, op.known_by);
    if (op.content.length > (first.content?.length ?? 0)) first.content = op.content;
    if (op.basis) first.basis = first.basis ? `${first.basis} | ${op.basis}` : op.basis;
    near.finding.basis = first.basis;
    near.finding.detail = coverageDetail(first);
    near.keys = JSON.stringify(first.keys ?? []);
    folded.push({ finding, into: near.finding, reason: `same-run duplicate: CREATE "${op.name}" names the entity an earlier window already proposed as CREATE "${first.name}" — folded into that proposal (keys/known_by merged, fuller content kept)` });
  }
  return folded;
}

// A finding that degraded to flagged-not-applied, kept STRUCTURED so it can
// persist to the review queue; the report still renders `text`.
interface FlaggedItem {
  text: string;
  finding: AuditFinding;
  reason: string;
}

interface UsageTally { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }

/** What an apply batch changed besides the ops themselves, for the run's
 *  events, details and the ruling outcomes: CREATEs whose reserved tag the
 *  shared sanitizer replaced, key limits that bound, and ops held at the write
 *  with their reason (heldOps.ts names them). */
interface ApplyNotes { retagged: string[]; keyCaps: KeyCapNote[]; held: HeldOp[] }
type ApplyResult = {
  appliedDetails: Array<{ op: string; entryId: string | null; name: string }>;
  toEmbed: Array<{ id: string; userId: string; content: string }>;
  conflicts: AuditOp[];
  notes: ApplyNotes;
};
/** A model's `known_by` as stored: null for common knowledge. */
function storedKnownBy(value: unknown): string | null {
  const normalized = normalizeKnownBy(value);
  return normalized.knownBy ? JSON.stringify(normalized.knownBy) : null;
}

function emptyApplyNotes(): ApplyNotes { return { retagged: [], keyCaps: [], held: [] }; }
function addApplyNotes(into: ApplyNotes, from: ApplyNotes): void { into.retagged.push(...from.retagged); into.keyCaps.push(...from.keyCaps); into.held.push(...from.held); }

/** Held write-time refusals as report `held` rows, one per op class and
 *  reason, in the reason vocabulary's order. Exported for tests. */
export function heldRefusalRows(held: readonly HeldOp[]): Array<{ opClass: string; count: number; reason: string }> {
  const rows: Array<{ opClass: string; count: number; reason: string }> = [];
  for (const opClass of ["update", "disable"]) {
    const ofClass = held.filter((h) => (h.op === "DISABLE" || h.op === "DELETE" ? "disable" : "update") === opClass);
    for (const [reason, count] of Object.entries(countHeldByReason(ofClass))) {
      const sample = ofClass.filter((h) => h.reason === reason);
      rows.push({ opClass, count: count!, reason: `${reason}: ${describeHeldOps(sample)} (${sample.map((h) => h.entryId).slice(0, 5).join(", ")}); ${count === 1 ? "the entry was kept as it is" : "the entries were kept as they are"}` });
    }
  }
  return rows;
}

interface AuditDetails {
  transcriptInput?: PipelineTranscriptManifest;
  transcriptSessionIds?: string[];
  mode: "quick" | "full";
  auditModel: string;
  embeddingModel: string;
  auto?: boolean;
  // Engine dial: explicit worker reasoning effort.
  workerEffort?: string;
  // Engine dial (2026-09-09): OpenAI fast mode where the audit model supports it.
  openaiFastMode?: boolean;
  progress?: { stage: string; current: number; total: number };
  checkpoint?: AuditCheckpoint;
  report?: CampaignAuditReport;
  // Resume bookkeeping (transient self-requeue): how many times this run has
  // requeued itself, and the ISO time before which the runner must not pick it
  // up again (laddered cooldown for Max-window recovery).
  resumeAttempts?: number;
  usageCarry?: UsageTally; // usage spent across prior (requeued) attempts of THIS run
  seededFrom?: string | null; // a DIFFERENT failed run this one resumed from
  // Checkpoint signature at the LAST failure — progress since then resets the
  // attempt streak (progress-aware resume accounting).
  lastFailureSig?: string;
  // Key limits that bound on this run's writes.
  keyCaps?: KeyCapNote[];
  // Both unusable map replies of the cluster that failed the run:
  // length, first and last 1,000 characters and the parse error of each.
  mapReplyFailures?: { cluster: number; clusters: number; modelId: string; attempts: Array<ReturnType<typeof unusableReplyEvidence>> };
}

// Everything a resumed run needs so it re-runs at most the adversarial tail
// (the cheap part), never the phase-1 sweep it already paid for.
interface AuditCheckpoint {
  phase1NextChunk: number;
  // Transcript LINES (= messages) already swept, cumulative. The
  // chunk ordinal above is kept for the progress signature and old
  // checkpoints, but resume positions on THIS. Manual audits re-read live
  // transcript; automatic audits retain their original input manifest, so a
  // length change inside an already-swept region shifts every later chunk
  // boundary — resuming by ordinal could skip a span of messages this run
  // never saw. Resuming by line count re-sweeps at most one boundary's worth.
  phase1LinesSwept?: number;
  findings: AuditFinding[];
  phase2NextCluster?: number;
  ledgers?: unknown[];
  reduceDone?: boolean;
  analysis?: string | null;
  messagesRead?: number;
  phase1Chunks?: number;
  // The next pending-CREATE ordinal, and CREATEs a later window
  // withdrew (DISABLE/DELETE of a pending id) — reported under `refuted`.
  pendingCounter?: number;
  withdrawn?: Array<{ finding: string; reason: string }>;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Let timers and I/O run (heartbeats, the fast lane) between synchronous steps. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Read-only tail of the NEXT chunk, appended to each sweep window.
 *
 * Chunk boundaries are hard, and a scene's meaning frequently arrives a few
 * messages after the scene. Measured case: a character is killed in graphic
 * detail, and FOUR messages later the killing is revealed as a forced vision
 * that never happened. A/B on that exact transcript (2026-07-29):
 *
 *   reveal OUTSIDE the window → the model records the death as fact, and it
 *     does so WITH OR WITHOUT an epistemic-status instruction. The information
 *     is simply not present; no prompt rule can recover it.
 *   reveal INSIDE the window  → the model gets it right, with or without the
 *     instruction. Coverage is what decides the outcome, not wording.
 *
 * So the fix is mechanical, not rhetorical: let each window see far enough
 * forward to catch its own reframing. Ops still come only from the window —
 * the next chunk emits its own.
 */
export function buildLookahead(nextChunk: string[] | undefined, maxChars = LOOKAHEAD_MAX_CHARS): string {
  if (!nextChunk?.length) return "";
  const taken: string[] = [];
  let size = 0;
  for (const line of nextChunk) {
    if (taken.length > 0 && size + line.length > maxChars) break;
    taken.push(line.length > maxChars ? line.slice(0, maxChars) + "…" : line);
    size += line.length + 1;
  }
  return `\n<lookahead note="CONTEXT ONLY — the messages immediately AFTER your window. Use these solely to determine whether events IN your window are what they appear to be: a later message may reveal a death, betrayal, or arrival to have been a vision, illusion, deception, or lie. Do NOT emit ops whose basis lies only in the lookahead — the next window covers that material.">\n${taken.join("\n")}\n</lookahead>\n`;
}

/** Chunk formatted transcript lines chronologically, breaking on message
 *  boundaries; a single oversized message becomes its own chunk. */
export function chunkTranscript(lines: string[], maxChars = CHUNK_MAX_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Group entries into tag-ordered clusters under a char budget. Tag grouping
 *  keeps same-kind entries together so intra-cluster contradiction checks see
 *  their natural neighbors; an oversized entry gets its own cluster. */
export function clusterEntries<T extends { tag: string | null; content: string; name: string }>(entries: T[], maxChars = CLUSTER_MAX_CHARS): T[][] {
  const sorted = [...entries].sort((a, b) => (a.tag ?? "~").localeCompare(b.tag ?? "~") || a.name.localeCompare(b.name));
  const clusters: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const e of sorted) {
    const cost = e.content.length + e.name.length + 80;
    if (current.length > 0 && size + cost > maxChars) {
      clusters.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += cost;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Keyword relevance: entries whose keys/name appear in the chunk text, ranked
 *  by hit count, capped. Entries beyond the cap are simply absent — the
 *  duplicate guard + validator + consolidation reconcile any resulting
 *  CREATE-instead-of-UPDATE downstream. */
export function relevantEntriesForChunk<T extends { name: string; keys: string; content: string }>(entries: T[], chunkText: string, cap = RELEVANT_ENTRIES_PER_CHUNK): T[] {
  const haystack = chunkText.toLowerCase();
  const scored: Array<{ entry: T; score: number }> = [];
  for (const entry of entries) {
    let keys: string[] = [];
    try { keys = JSON.parse(entry.keys); } catch { /* malformed keys — name-only match */ }
    const needles = [...new Set([entry.name, ...keys])].map((k) => String(k).toLowerCase().trim()).filter((k) => k.length >= 3);
    let score = 0;
    for (const needle of needles) if (haystack.includes(needle)) score++;
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, cap).map((s) => s.entry);
}

/** Name/key fallback duplicate detector, run on every CREATE the embedding
 *  guard did not flag (vectors are the PRIMARY guard; this is the cheap
 *  second look). A CREATE is a likely duplicate of the returned entry when:
 *  - the normalized names are EQUAL, or
 *  - the candidate's name is one of the entry's keys / the entry's name is
 *    one of the candidate's keys (exact, normalized), or
 *  - ≥50% of the candidate's keys (2+) appear in the entry's keys.
 *  Deliberately NO substring containment: the old
 *  `includes` in both directions had no word boundary and no minimum length,
 *  so an existing "Ash" swallowed CREATE "Washington Bridge" and "Q" swallowed
 *  "The Quarry" — the CREATE was rewritten into a full-replacement UPDATE of an
 *  unrelated entry, which the validator then either refuted (the coverage lost
 *  on every FULL run) or merged (the unrelated entry polluted). A missed
 *  duplicate is the cheaper error: consolidation reconciles it later. */
export function nearestByNameKeys<T extends { id: string; name: string; keys: string }>(existing: T[], candidate: { name: string; keys?: string[] }): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const candName = norm(candidate.name);
  if (!candName) return null;
  const candKeys = new Set((candidate.keys ?? []).map(norm).filter(Boolean));
  for (const entry of existing) {
    const entryName = norm(entry.name);
    if (entryName === candName) return entry;
    let keys: string[] = [];
    try { keys = JSON.parse(entry.keys); } catch { continue; }
    const entryKeys = new Set((Array.isArray(keys) ? keys : []).map((k) => norm(String(k))).filter(Boolean));
    if (entryKeys.has(candName) || (entryName && candKeys.has(entryName))) return entry;
    if (candKeys.size >= 2) {
      let overlap = 0;
      for (const k of candKeys) if (entryKeys.has(k)) overlap++;
      if (overlap / candKeys.size >= 0.5) return entry;
    }
  }
  return null;
}

/** Phase-1 resume position: the first chunk that contains a line
 *  this run has not swept yet, over the LIVE re-chunking. Lines already
 *  swept = `linesSwept`; a chunk whose lines all fall below that count is
 *  done. Returns `chunks.length` when everything is covered. */
export function resumeChunkIndex(chunks: string[][], linesSwept: number): number {
  let seen = 0;
  for (let i = 0; i < chunks.length; i++) {
    const end = seen + chunks[i]!.length;
    if (end > linesSwept) return i;
    seen = end;
  }
  return chunks.length;
}

/** Second-round CAS conflicts grouped by op class, in the same lowercase
 *  vocabulary `applyOpClassCaps` uses: DELETE folds into disable
 *  exactly as the caps do, so the report/summary never says "UPDATEs HELD"
 *  about a batch of DISABLEs. */
export function heldByClass(conflicts: AuditOp[], reason: (count: number) => string): Array<{ opClass: string; count: number; reason: string }> {
  const counts = new Map<string, number>();
  for (const op of conflicts) {
    const cls = op.op === "DISABLE" || op.op === "DELETE" ? "disable" : op.op.toLowerCase();
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts.entries()].map(([opClass, count]) => ({ opClass, count, reason: reason(count) }));
}

/** Op-class blast-radius caps. Returns which classes are HELD.
 *  CREATE is never capped. */
export function applyOpClassCaps(ops: AuditOp[], existingCount: number): { allowed: AuditOp[]; held: Array<{ opClass: string; count: number; reason: string }> } {
  const creates = ops.filter((o) => o.op === "CREATE");
  const updates = ops.filter((o) => o.op === "UPDATE");
  const disables = ops.filter((o) => o.op === "DISABLE" || o.op === "DELETE");
  const held: Array<{ opClass: string; count: number; reason: string }> = [];
  const allowed: AuditOp[] = [...creates];

  const disableCap = Math.max(DISABLE_CAP_FLOOR, Math.ceil(existingCount * DISABLE_CAP_FRACTION));
  if (disables.length > disableCap) {
    held.push({ opClass: "disable", count: disables.length, reason: `${disables.length} disables > cap ${disableCap} (max(${DISABLE_CAP_FLOOR}, ${Math.round(DISABLE_CAP_FRACTION * 100)}% of ${existingCount})) — mass removal of established canon is more likely model error than drift` });
  } else {
    allowed.push(...disables);
  }

  const updateCap = Math.ceil(existingCount * UPDATE_CAP_FRACTION);
  if (updates.length > updateCap) {
    held.push({ opClass: "update", count: updates.length, reason: `${updates.length} updates > cap ${updateCap} (${Math.round(UPDATE_CAP_FRACTION * 100)}% of ${existingCount}) — a wholesale rewrite is a red flag` });
  } else {
    allowed.push(...updates);
  }

  return { allowed, held };
}

/** Where the checkpoint stands, as a comparable token. Two equal signatures
 *  across consecutive failures = zero progress between them. */
export function checkpointSignature(cp: { phase1NextChunk?: number; findings?: unknown[]; phase2NextCluster?: number; reduceDone?: boolean } | null | undefined): string {
  if (!cp) return "none";
  return `${cp.phase1NextChunk ?? -1}|${cp.findings?.length ?? -1}|${cp.phase2NextCluster ?? -1}|${cp.reduceDone ? 1 : 0}`;
}

/** Progress-aware resume accounting: progress since the last failure
 *  starts a NEW streak, so MAX_RESUME_ATTEMPTS bounds consecutive no-progress
 *  failures (a wedge) instead of lifetime hiccups — a huge campaign's
 *  hours-long audit may legitimately eat several transients while advancing
 *  its checkpoint every time. */
export function nextResumeAttempts(prevAttempts: number, prevSig: string | undefined, sig: string): number {
  return prevSig !== undefined && prevSig !== sig ? 1 : prevAttempts + 1;
}

/** Parse {"verdicts":[{index, ok, reason?, fixedOp?}]} defensively. Returns a
 *  map index→verdict; indexes absent from the map are UNVERDICTED (the caller
 *  degrades them to flagged-not-applied — never silently applied or dropped). */
export function parseVerdicts(text: string): Map<number, { ok: boolean; reason?: string; fixedOp?: AuditOp }> {
  const out = new Map<number, { ok: boolean; reason?: string; fixedOp?: AuditOp }>();
  const seen = new Set<number>();
  const parsed = parseFirstJson<{ verdicts?: Array<{ index?: number; ok?: boolean; reason?: string; fixedOp?: AuditOp }> }>(text, "{");
  for (const v of Array.isArray(parsed?.verdicts) ? parsed!.verdicts : []) {
    if (!Number.isInteger(v?.index) || v.index! < 0) continue;
    const index = v.index!;
    if (seen.has(index)) { out.delete(index); continue; }
    seen.add(index);
    if (typeof v.ok !== "boolean") continue;
    out.set(index, { ok: v.ok, reason: v.reason ? String(v.reason) : undefined, fixedOp: v.fixedOp && typeof v.fixedOp === "object" ? v.fixedOp : undefined });
  }
  return out;
}

/** Transcript evidence lines for the refute, resolver and ruling-plan calls:
 *  FTS returns raw message rows, and a user turn's
 *  [OOC: …] beat sheet is a plan for the composer, never an event, so it must
 *  not reach a canon decision as "transcript evidence".
 *  OOC is stripped where the excerpt is rendered (the accepted-input manifest
 *  keeps hashing the raw row), and a hit whose stripped text is empty is
 *  dropped. Exported for tests. */
export function renderEvidenceExcerpts(hits: Array<{ createdAt: string; content: string }>, maxChars: number): string[] {
  const lines: string[] = [];
  for (const hit of hits) {
    const text = stripOocBlocks(hit.content).trim();
    if (!text) continue;
    lines.push(`- [${hit.createdAt.slice(0, 10)}] ${text.slice(0, maxChars)}`);
  }
  return lines;
}

/** Why a Phase-2 map reply cannot be used, or null when it can.
 *  The run used to fail on the first unusable reply with only its id in
 *  the event; the reason now rides in the re-ask and in the failure event.
 *  Exported for tests. */
export function mapReplyProblem(text: string): string | null {
  const parsed = parseFirstJson<{ contradictions?: unknown; ledger?: unknown }>(text, "{");
  // parseFirstJson falls through to later candidates, so a cut-off reply can
  // "parse" to one of its own inner objects; an object with neither key is
  // diagnosed from the reply's first object instead.
  if (!parsed || typeof parsed !== "object" || (!("contradictions" in parsed) && !("ledger" in parsed))) return jsonObjectProblem(text);
  if (!Array.isArray(parsed.contradictions)) return "\"contradictions\" is missing or is not an array";
  const badClaim = parsed.contradictions.findIndex((item) => !validClaims([item]));
  if (badClaim >= 0) return `contradictions[${badClaim}] needs a non-empty "claim", an "entryIds" array of strings and, when present, a string "detail"`;
  if (!Array.isArray(parsed.ledger)) return "\"ledger\" is missing or is not an array";
  const badEntity = parsed.ledger.findIndex((item) => !validLedger([item]));
  if (badEntity >= 0) return `ledger[${badEntity}] needs a non-empty "entity" and "claims" whose items carry a non-empty "text" and "entryId"`;
  return null;
}

/** Why a reply has no usable JSON object, judged from its first "{": none at
 *  all, an object that never closes (a cut-off reply), the JSON.parse error of
 *  the first balanced object, or an object without the expected keys. */
function jsonObjectProblem(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text.trim() ? "the reply contains no JSON object" : "the reply is empty";
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < text.length && end < 0; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) end = i;
  }
  if (end < 0) return "the JSON object never closes (the reply may be cut off)";
  try {
    JSON.parse(text.slice(start, end + 1));
    return "the reply's JSON object has neither \"contradictions\" nor \"ledger\"";
  } catch (error) {
    return `the JSON object does not parse: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What an event keeps of an unusable reply: its length, the
 *  first 1,000 characters, the last 1,000 characters that follow them, and the
 *  parse error. Exported for tests. */
export function unusableReplyEvidence(text: string, parseError: string): { responseLen: number; head: string; tail: string; parseError: string } {
  return { responseLen: text.length, head: text.slice(0, 1000), tail: text.length > 1000 ? text.slice(Math.max(1000, text.length - 1000)) : "", parseError };
}

// ── Worker ───────────────────────────────────────────────────────────────────

export class CampaignAuditWorker {
  private readonly logger = createLogger("campaign-audit-worker");
  private lastBeatFailureLogAt = 0;
  // Evidence-search cost for the run in flight (2026-09-27): the synchronous
  // FTS search is what froze the worker loop for 8 minutes; the report carries
  // the totals so a regression is visible without a profiler. Kept per
  // campaign: two campaigns' audits run at once in their own lanes since
  // 2026-10-02, and a campaign's audit and ruling never overlap.
  private readonly evidenceStats = new Map<string, { searches: number; totalMs: number; maxMs: number }>();

  private evidenceStatsFor(campaignId: string) {
    let stats = this.evidenceStats.get(campaignId);
    if (!stats) {
      stats = { searches: 0, totalMs: 0, maxMs: 0 };
      this.evidenceStats.set(campaignId, stats);
    }
    return stats;
  }
  private readonly lorebook;
  private readonly campaigns;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly findingsRepo;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;
  private readonly embeddingRepo;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.campaigns = new CampaignRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.findingsRepo = new AuditFindingRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    this.embeddingRepo = new LorebookEmbeddingRepository(db);
    this.embedding = new EmbeddingService(this.embeddingRepo, buildEmbeddingProviders(this.runtimeDefaults), this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const startedAt = new Date().toISOString();
    this.evidenceStats.set(run.campaignId, { searches: 0, totalMs: 0, maxMs: 0 });
    // Revision provenance is scoped to each WRITE BATCH via
    // lorebook.withRevisionContext: this worker instance is
    // shared by the slow-lane audit and the fast-lane ruling executor, and the
    // audit↔ruling lock is per campaign — a ruling on campaign B landing while
    // audit A reasons for hours used to re-stamp the instance-wide context, so
    // A's apply captured every revision as `campaign_audit_ruling`/B (History
    // tab + revert attribution pointing at the wrong run of the wrong campaign).
    const revisionCtx: { source: "campaign_audit"; pipelineRunId: string; assertSource?: () => void } = { source: "campaign_audit", pipelineRunId: run.id };
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      revisionCtx.assertSource = assertSource;
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, startedAt, "campaign not found", null); return; }
      const details = (run.detailsJson ? JSON.parse(run.detailsJson) : {}) as AuditDetails;
      details.transcriptInput = inputs.manifest;
      if (details.mode !== "quick" && details.mode !== "full") { this.runs.markFailed(run.id, startedAt, "audit mode missing", run.detailsJson ?? null); return; }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, startedAt, "no chat runtime available", run.detailsJson ?? null); return; }
      // An unresolvable auditModel dial fails the run loudly; it used to fall
      // back to the deployment default while `latest()` kept
      // reporting the dial as the run's model.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "campaign_audit", "campaign audit", details.auditModel, getConfiguredDefaultModelId() ?? "claude-opus-4-6-bridge");
      // A run stamped without a model (older rows, hand-queued fixtures) takes
      // the campaign's newest session's dial, never the shipped id.
      const embedModelId = details.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);
      const effortDial = details.workerEffort ?? null;

      // Auditable entries: enabled, non-constant, non-tracker-owned (threads are
      // the thread-tracker worker's property; the apply guard skips them anyway,
      // so feeding them to the audit only wastes budget and proposal effort).
      // Offscreen-flow (2026-07-17): provisional offscreen entries are ALSO
      // excluded from the transcript-grounded machinery — they never appear in
      // the transcript by design, so demanding transcript evidence for them
      // produced only undecidable flags (the 07-17 22-finding flood). They get
      // their own offscreen-coherence pass instead.
      const offscreenActive = listActiveOffscreen(this.lorebook, run.userId, run.campaignId);
      const offscreenIds = new Set(offscreenActive.map((o) => o.id));
      const allEntries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId)
        .filter((e) => !e.isConstant && e.tag !== "threads" && !offscreenIds.has(e.id));

      const startMs = Date.parse(startedAt);
      const usage: UsageTally = details.usageCarry ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      // Alias the tally INTO details from the first persist: on a
      // fresh run `usageCarry` was undefined, so the per-chunk/per-cluster
      // checkpoints serialized a details object WITHOUT the tally and a
      // transient death before the reduce checkpoint lost every token of the
      // first attempt from the final usage block. Later attempts already
      // aliased by reference; this makes the first one symmetric.
      details.usageCarry = usage;
      if (inputs.source) this.lorebook.transact(() => { assertSource(); this.persist(run.id, details); });
      const cp = details.checkpoint;
      const findings: AuditFinding[] = cp?.findings ? [...cp.findings] : [];
      let messagesRead = cp?.messagesRead ?? 0;
      let phase1Chunks = cp?.phase1Chunks ?? 0;
      // Pending CREATEs: every CREATE this run has proposed so far,
      // keyed by a run-scoped id, so later windows see them as entries (rule
      // 2b) and fold into them instead of creating the entity again. Rebuilt
      // from the checkpoint on resume; a CREATE from a pre-09-23 checkpoint
      // without an id is assigned one here.
      let pendingCounter = cp?.pendingCounter ?? 0;
      const pendingById = new Map<string, AuditFinding>();
      const withdrawn: Array<{ finding: string; reason: string }> = cp?.withdrawn ? [...cp.withdrawn] : [];
      for (const finding of findings) {
        if (finding.kind !== "coverage" || finding.op?.op !== "CREATE") continue;
        if (!finding.pendingId) finding.pendingId = `pending:${++pendingCounter}`;
        pendingById.set(finding.pendingId, finding);
      }

      // ── Phase 1 (FULL only) — coverage sweep from message 1 ────────────────
      if (details.mode === "full") {
        const sessionRows = this.sessions.listForCampaign(run.userId, run.campaignId)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const sessionIds = inputs.source ? (details.transcriptSessionIds ??= sessionRows.map((s) => s.id)) : sessionRows.map((s) => s.id);
        const lines: string[] = [];
        let msgCount = 0;
        for (const sessionId of sessionIds) {
          const msgs = inputs.readSession(sessionId).filter((m) => m.role !== "cold-start");
          msgCount += msgs.length;
          for (const m of msgs) {
            let scenePrefix = "";
            if ((m as { sceneData?: string | null }).sceneData) {
              try {
                const scene = JSON.parse((m as { sceneData?: string | null }).sceneData!);
                if (scene?.location) scenePrefix = `[SCENE: ${scene.location}${scene.date ? ` | ${scene.date}${scene.time ? ` ${scene.time}` : ""}` : ""}]\n`;
              } catch { /* unparseable scene — plain line */ }
            }
            // Canon writer: OOC planning text is stripped (see stripOoc.ts) —
            // also keeps the audit from pairing plan-text against rendered prose.
            lines.push(`[${m.role}]: ${scenePrefix}${stripOocBlocks(m.content).trim()}`);
          }
        }
        if (inputs.source) this.lorebook.transact(() => { assertSource(); this.persist(run.id, details); });
        const chunks = chunkTranscript(lines);
        phase1Chunks = chunks.length;
        messagesRead = msgCount;
        // Resume by swept LINE COUNT over the live re-chunking; the
        // chunk ordinal is the fallback for checkpoints written before the
        // line count existed.
        const startChunk = cp?.phase1LinesSwept != null ? resumeChunkIndex(chunks, cp.phase1LinesSwept) : (cp?.phase1NextChunk ?? 0);
        let linesSwept = chunks.slice(0, startChunk).reduce((n, c) => n + c.length, 0);
        const entryById = new Map(allEntries.map((e) => [e.id, e]));
        // Pending CREATEs render as entries for keyword relevance and the
        // sweep block; the refine pass resolves either kind.
        const pendingAsEntry = (id: string, f: AuditFinding) => ({ id, name: f.op!.name!, tag: f.op!.tag ?? null, keys: JSON.stringify(f.op!.keys ?? []), content: f.op!.content!, pending: true as const });
        const resolveTarget = (id: string): { id: string; name: string; tag: string | null; content: string } | undefined => {
          const live = entryById.get(id);
          if (live) return live;
          const pending = pendingById.get(id);
          return pending ? pendingAsEntry(id, pending) : undefined;
        };
        for (let i = startChunk; i < chunks.length; i++) {
          if (signal?.aborted) throw abortError();
          const chunkText = chunks[i]!.join("\n");
          const sweepEntries = [...allEntries.map((e) => ({ id: e.id, name: e.name, tag: e.tag, keys: e.keys, content: e.content, pending: false as const })), ...[...pendingById.entries()].map(([id, f]) => pendingAsEntry(id, f))];
          const relevant = relevantEntriesForChunk(sweepEntries, chunkText);
          const entriesBlock = relevant.map((e) => `- id=${e.id} | ${e.name}${e.tag ? ` (${e.tag})` : ""}${e.pending ? " [PROPOSED EARLIER THIS AUDIT — UPDATE it, never CREATE it again]" : ""}\n  ${e.content.length > SWEEP_ENTRY_VIEW_CHARS ? e.content.slice(0, SWEEP_ENTRY_VIEW_CHARS) + "…" : e.content}`).join("\n") || "(none matched this window — CREATE what the story establishes)";
          const lookahead = buildLookahead(chunks[i + 1]);
          const user = `<window index="${i + 1}" of="${chunks.length}">\n${chunkText}\n</window>\n${lookahead}\n<existing_entries>\n${entriesBlock}\n</existing_entries>`;
          this.runs.heartbeat(run.id);
          const text = await this.callModel(runtime, modelId, SWEEP_SYSTEM, user, `campaign-audit-${run.id}-sweep-${i}`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
          const rawOps = parseFirstJson<AuditOp[]>(text, "[");
          if (!Array.isArray(rawOps) || !rawOps.every(isAuditOperation)) throw new Error("campaign audit coverage returned invalid operations — coverage not checkpointed");
          const chunkOps: AuditOp[] = [];
          for (const op of Array.isArray(rawOps) ? rawOps : []) {
            if (!op || typeof op !== "object" || op.op === "NOOP") continue;
            if (op.op === "CREATE" && (!op.name || !op.content)) continue;
            if ((op.op === "UPDATE" || op.op === "DISABLE" || op.op === "DELETE") && !op.entry_id) continue;
            // A pending id that no longer exists (withdrawn, or hallucinated)
            // can never be a target — dropped here rather than reaching the
            // tail as an op on a non-entry.
            if (op.entry_id?.startsWith("pending:") && !pendingById.has(op.entry_id)) continue;
            chunkOps.push(op);
          }
          // ── Refine ────────────────────────────────────────────────────
          // An UPDATE authored against a target the window showed TRUNCATED is
          // a blind full-replacement rewrite; the validator was the only guard
          // and it saw a truncated view too. One scoped call per window
          // re-authors those ops with the whole target in hand (NOOP when the
          // full content already carries the material).
          const blind = chunkOps.map((op, idx) => ({ op, idx })).filter(({ op }) => {
            if (op.op !== "UPDATE" || !op.entry_id || !op.content) return false;
            const target = resolveTarget(op.entry_id);
            return Boolean(target && target.content.length > SWEEP_ENTRY_VIEW_CHARS);
          });
          if (blind.length > 0) {
            const items = blind.map(({ op }, n) => {
              const target = resolveTarget(op.entry_id!)!;
              return `ITEM ${n} — target id=${target.id} | ${target.name}${target.tag ? ` (${target.tag})` : ""}\nbasis: ${op.basis ?? "(none given)"}\nproposed content (authored from the truncated view): ${op.content}\n<target_full_current_content>\n${target.content}\n</target_full_current_content>`;
            }).join("\n\n");
            this.runs.heartbeat(run.id);
            const refineText = await this.callModel(runtime, modelId, SWEEP_REFINE_SYSTEM, items, `campaign-audit-${run.id}-refine-${i}`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
            const refined = parseFirstJson<{ ops?: Array<{ index?: number; op?: string; content?: string; keys?: string[]; known_by?: string[] | null; basis?: string }> }>(refineText, "{");
            const byIndex = new Map<number, { op?: string; content?: string; keys?: string[]; known_by?: string[] | null; basis?: string }>();
            for (const r of Array.isArray(refined?.ops) ? refined!.ops : []) if (typeof r?.index === "number") byIndex.set(r.index, r);
            const drop = new Set<number>();
            blind.forEach(({ op, idx }, n) => {
              const r = byIndex.get(n);
              // Unrefined (missing index / unparseable): the original op stays
              // and the validator — which now sees the full target — judges it.
              if (!r) return;
              if (r.op === "NOOP") { drop.add(idx); return; }
              if (r.op === "UPDATE" && typeof r.content === "string" && r.content.length > 0) {
                op.content = r.content;
                if (Array.isArray(r.keys) && r.keys.length > 0) op.keys = r.keys;
                if (r.known_by !== undefined) op.known_by = r.known_by;
                if (r.basis) op.basis = String(r.basis);
              }
            });
            for (let k = chunkOps.length - 1; k >= 0; k--) if (drop.has(k)) chunkOps.splice(k, 1);
          }
          for (const op of chunkOps) {
            // Ops on a PENDING create fold into it: an UPDATE is the
            // model's full replacement of the earlier window's proposal; a
            // DISABLE/DELETE withdraws it (a later window reframed the event
            // — a vision, a lie). Never a second finding on a non-entry.
            const pending = op.entry_id ? pendingById.get(op.entry_id) : undefined;
            if (pending) {
              if (op.op === "UPDATE") { foldIntoPendingCreate(pending, op); continue; }
              const at = findings.indexOf(pending);
              if (at >= 0) findings.splice(at, 1);
              pendingById.delete(op.entry_id!);
              withdrawn.push({ finding: pending.summary, reason: `withdrawn by window ${i + 1} (${op.op} of the pending proposal${op.basis ? `: ${op.basis}` : ""})` });
              continue;
            }
            // Structured for the queue: a flagged coverage op used to
            // persist with no entry ids and no detail — the owner saw
            // "UPDATE 01J…" with nothing to rule on, same-run withdrawal never
            // matched it, and the ruling executor was told the implicated
            // entries no longer existed.
            const targetName = op.entry_id ? entryById.get(op.entry_id)?.name : undefined;
            const finding: AuditFinding = {
              kind: "coverage",
              summary: `${op.op} ${op.name ?? targetName ?? op.entry_id}`,
              detail: coverageDetail(op),
              entryIds: op.entry_id ? [op.entry_id] : [],
              op, basis: op.basis,
            };
            if (op.op === "CREATE") {
              finding.pendingId = `pending:${++pendingCounter}`;
              pendingById.set(finding.pendingId, finding);
            }
            findings.push(finding);
          }
          linesSwept += chunks[i]!.length;
          details.checkpoint = { phase1NextChunk: i + 1, phase1LinesSwept: linesSwept, findings, messagesRead, phase1Chunks, pendingCounter, withdrawn };
          details.progress = { stage: "phase1", current: i + 1, total: chunks.length };
          this.persist(run.id, details);
        }
      }

      // ── Phase 2 — coherence map-reduce (checkpoint-resumable per cluster) ───
      const clusters = clusterEntries(allEntries);
      const ledgers: unknown[] = cp?.ledgers ? [...cp.ledgers] : [];
      const startCluster = cp?.phase2NextCluster ?? 0;
      for (let i = startCluster; i < clusters.length; i++) {
        if (signal?.aborted) throw abortError();
        const cluster = clusters[i]!;
        const block = cluster.map((e) => `### id=${e.id} | ${e.name}${e.tag ? ` (${e.tag})` : ""}\n${e.content}`).join("\n\n");
        this.runs.heartbeat(run.id);
        details.progress = { stage: "phase2", current: i + 1, total: clusters.length };
        const mapUser = `<entries>\n${block}\n</entries>`;
        let text = await this.callModel(runtime, modelId, MAP_SYSTEM, mapUser, `campaign-audit-${run.id}-map-${i}`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
        // One scoped re-ask: an unusable reply gets the same
        // cluster again with the reason, before the run fails. Each reply's
        // evidence (length, first and last 1,000 characters, parse error) is
        // recorded, which is what the 09-08 and 09-09 failures lacked: one event
        // per reply (system_events details are capped at 4,000 characters), and
        // on failure both replies in the failed run's details, uncapped.
        const firstProblem = mapReplyProblem(text);
        if (firstProblem) {
          const first = unusableReplyEvidence(text, firstProblem);
          const where = `campaign audit map cluster ${i + 1} of ${clusters.length}`;
          this.runs.heartbeat(run.id);
          text = await this.callModel(runtime, modelId, MAP_SYSTEM, `${mapUser}\n\n${mapReask(firstProblem)}`, `campaign-audit-${run.id}-map-${i}-reask`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
          const secondProblem = mapReplyProblem(text);
          recordSystemEvent({
            userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
            message: `${where} returned an unusable reply (${firstProblem}); ${secondProblem ? "the scoped re-ask was unusable too" : "one scoped re-ask recovered it"}`,
            details: { runId: run.id, cluster: i + 1, clusters: clusters.length, modelId, attempt: 1, ...first },
          });
          if (secondProblem) {
            const second = unusableReplyEvidence(text, secondProblem);
            details.mapReplyFailures = { cluster: i + 1, clusters: clusters.length, modelId, attempts: [first, second] };
            this.persist(run.id, details);
            recordSystemEvent({
              userId: run.userId, source: "campaign_audit", severity: "warn", campaignId: run.campaignId,
              message: `${where} returned an unusable reply again after the scoped re-ask (${secondProblem}); the run fails with this cluster unchecked and no findings closed`,
              details: { runId: run.id, cluster: i + 1, clusters: clusters.length, modelId, attempt: 2, ...second },
            });
            throw new Error("campaign audit map returned invalid findings/ledger — coverage not checkpointed");
          }
        }
        const parsed = parseFirstJson<{ contradictions: Array<{ entryIds: string[]; claim: string; detail?: string }>; ledger: unknown[] }>(text, "{")!;
        for (const c of parsed.contradictions) {
          if (c?.claim) findings.push({ kind: "contradiction", summary: String(c.claim), detail: c.detail ? String(c.detail) : undefined, entryIds: Array.isArray(c.entryIds) ? c.entryIds.map(String) : [] });
        }
        if (Array.isArray(parsed?.ledger)) ledgers.push(...parsed!.ledger);
        details.checkpoint = { phase1NextChunk: phase1Chunks, findings, phase2NextCluster: i + 1, ledgers, messagesRead, phase1Chunks, pendingCounter, withdrawn };
        this.persist(run.id, details);
      }

      let analysis: string | null = cp?.analysis ?? null;
      if (!cp?.reduceDone && (ledgers.length > 0 || clusters.length > 0)) {
        this.runs.heartbeat(run.id);
        details.progress = { stage: "reduce", current: 1, total: 1 };
        this.persist(run.id, details);
        const ledgerText = JSON.stringify(ledgers);
        if (ledgerText.length > 400_000) throw new Error("campaign audit entity ledger exceeds the complete-input budget — audit held instead of dropping unswept claims");
        const text = await this.callModel(runtime, modelId, REDUCE_SYSTEM, `<ledgers>\n${ledgerText}\n</ledgers>`, `campaign-audit-${run.id}-reduce`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
        const parsed = parseFirstJson<{ contradictions?: Array<{ entryIds?: string[]; claim?: string; detail?: string }>; stale?: Array<{ entryIds?: string[]; claim?: string; detail?: string }>; analysis?: string }>(text, "{");
        if (!parsed || !validClaims(parsed.contradictions) || !validClaims(parsed.stale) || typeof parsed.analysis !== "string") throw new Error("campaign audit reduce returned invalid findings — prior findings remain open");
        for (const c of parsed.contradictions) {
          if (c?.claim) findings.push({ kind: "contradiction", summary: String(c.claim), detail: c.detail ? String(c.detail) : undefined, entryIds: Array.isArray(c.entryIds) ? c.entryIds.map(String) : [] });
        }
        for (const s of Array.isArray(parsed?.stale) ? parsed!.stale : []) {
          if (s?.claim) findings.push({ kind: "stale", summary: String(s.claim), detail: s.detail ? String(s.detail) : undefined, entryIds: Array.isArray(s.entryIds) ? s.entryIds.map(String) : [] });
        }
        analysis = typeof parsed?.analysis === "string" ? parsed.analysis : null;
        // Reduce done: findings + ledgers frozen. A resume past here re-runs only
        // the (cheap) adversarial tail, never the phase-1/phase-2 model calls.
        details.checkpoint = { phase1NextChunk: phase1Chunks, findings, phase2NextCluster: clusters.length, ledgers, reduceDone: true, analysis, messagesRead, phase1Chunks, pendingCounter, withdrawn };
        details.usageCarry = usage;
        this.persist(run.id, details);
      }

      // ── Tail-start world refresh ───────────────────────────────────────────
      // The run-start snapshot may be hours old at max effort, and the fast
      // lane kept writing meanwhile. Everything from here judges against the
      // LIVE lorebook: dedup, caps denominator, validation (which already
      // renders live), and the CAS stamps.
      const tailEntries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId)
        .filter((e) => !e.isConstant && e.tag !== "threads" && !offscreenIds.has(e.id));

      // ── Duplicate guard on CREATEs (Phase 1 idempotency) ───────────────────
      // Sibling CREATEs first: rule 2b lets later windows fold into
      // an earlier window's proposal, but a model that re-CREATEs anyway must
      // not land N copies. Exact name / key overlap folds here; the embedding
      // check below also compares each remaining candidate against the
      // candidates before it. Folded findings go to the report's `refuted`.
      const refuted: Array<{ finding: string; reason: string }> = [...withdrawn];
      for (const fold of foldSiblingCreates(findings)) {
        findings.splice(findings.indexOf(fold.finding), 1);
        refuted.push({ finding: fold.finding.summary, reason: fold.reason });
      }
      const vectors = this.embeddingRepo.listForCampaignAndModel(run.userId, run.campaignId, embedModelId);
      const decoded = vectors.map((v) => ({ entryId: v.entryId, vec: decodeVector(v.vector) }));
      const byId = new Map(tailEntries.map((e) => [e.id, e]));
      const siblingVectors: Array<{ finding: AuditFinding; vec: Float32Array }> = [];
      const embeddingFolds: AuditFinding[] = [];
      for (const finding of findings) {
        const op = finding.op;
        if (!op || op.op !== "CREATE" || !op.name || !op.content) continue;
        let duplicateOf: { id: string; name: string } | null = null;
        if (decoded.length > 0) {
          // Each candidate costs one embedding call (60-s provider timeout);
          // beat per candidate so a slow endpoint cannot starve the stale-lock
          // sweep across a long CREATE list.
          this.runs.heartbeat(run.id);
          const queryVec = await this.embedding.embedQuery(`${op.name}\n${op.content.slice(0, 800)}`, embedModelId, run.userId).catch(() => null);
          if (queryVec) {
            let best: { entryId: string; score: number } | null = null;
            for (const v of decoded) {
              const score = cosineSimilarity(queryVec, v.vec);
              if (!best || score > best.score) best = { entryId: v.entryId, score };
            }
            if (best && best.score >= DEDUP_SIMILARITY && byId.has(best.entryId)) duplicateOf = { id: best.entryId, name: byId.get(best.entryId)!.name };
            if (!duplicateOf) {
              const sibling = siblingVectors.find((s) => cosineSimilarity(queryVec, s.vec) >= DEDUP_SIMILARITY);
              if (sibling) {
                foldSiblingCreates([sibling.finding, finding]);
                embeddingFolds.push(finding);
                refuted.push({ finding: finding.summary, reason: `same-run duplicate: CREATE "${op.name}" is semantically the entity an earlier window proposed as CREATE "${sibling.finding.op!.name}" — folded into that proposal` });
                continue;
              }
              siblingVectors.push({ finding, vec: queryVec });
            }
          }
        }
        if (!duplicateOf) {
          const near = nearestByNameKeys(tailEntries, { name: op.name, keys: op.keys });
          if (near) duplicateOf = { id: near.id, name: near.name };
        }
        if (duplicateOf) {
          // Convert to an UPDATE-candidate on the nearest entry; the validator
          // judges whether the merged content preserves the existing facts.
          finding.op = { ...op, op: "UPDATE", entry_id: duplicateOf.id };
          finding.summary = `UPDATE ${duplicateOf.name} (dedup: proposed CREATE "${op.name}" matched existing)`;
          finding.entryIds = [duplicateOf.id];
          finding.detail = coverageDetail(finding.op);
        }
      }
      for (const fold of embeddingFolds) findings.splice(findings.indexOf(fold), 1);

      // ── Offscreen coherence pass (offscreen-flow 2026-07-17) ──────────────
      // Provisional offscreen entries reconcile against THEIR OWN timeline
      // (newest-per-fact wins) — never against the transcript. Writes are
      // provisional-only, revisioned, and reversible, so they apply directly;
      // FLAG ops (genuinely different irreconcilable facts) join the normal
      // findings queue.
      const flagged: FlaggedItem[] = [];
      let offscreenReconciled = 0;
      if (offscreenActive.length >= 2) {
        details.progress = { stage: "offscreen", current: 0, total: 1 };
        this.persist(run.id, details);
        // FULL content per entry: MERGE content is a FULL replacement
        // for keep_id and worldApply's entries routinely run 800–1500 chars —
        // the old 1200-char slice had the model author the replacement from a
        // view missing exactly the tail it was told to preserve.
        const ledgerSourceVersions = new Map(offscreenActive.flatMap((entry) => {
          const source = this.lorebook.findById(run.userId, entry.id);
          return source ? [[entry.id, canonSourceVersion(source)] as const] : [];
        }));
        const ledgerBlock = offscreenActive.map((o) => `### id=${o.id} | created=${o.createdAt} | window=${o.window ?? "?"} | knownBy=${o.knownBy.join(", ") || "unscoped"}\n${o.content}`).join("\n\n");
        const offText = await this.callModel(runtime, modelId, OFFSCREEN_COHERENCE_SYSTEM, `<offscreen_ledger newest_first>\n${ledgerBlock}\n</offscreen_ledger>`, `campaign-audit-${run.id}-offscreen`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
        const offOps = parseFirstJson<{ ops?: Array<{ op?: string; entry_id?: string; by?: string; keep_id?: string; absorb_ids?: string[]; content?: string; entry_ids?: string[]; claim?: string; detail?: string; reason?: string }> }>(offText, "{")?.ops;
        if (!Array.isArray(offOps) || offOps.some((op) => {
          if (!op) return true;
          if (op.op === "SUPERSEDE") return typeof op.entry_id !== "string" || !op.entry_id || typeof op.by !== "string" || !op.by;
          if (op.op === "MERGE") return typeof op.keep_id !== "string" || !op.keep_id || typeof op.content !== "string" || !op.content.trim() || !Array.isArray(op.absorb_ids) || !op.absorb_ids.length || !op.absorb_ids.every((id) => typeof id === "string" && !!id);
          if (op.op === "FLAG") return typeof op.claim !== "string" || !op.claim.trim() || !Array.isArray(op.entry_ids) || !op.entry_ids.length || !op.entry_ids.every((id) => typeof id === "string" && !!id);
          return true;
        })) throw new Error("campaign audit offscreen pass returned invalid operations — prior findings remain open");
        const ledgerById = new Map(offscreenActive.map((o) => [o.id, o]));
        const consumed = new Set<string>();
        // MERGE is a content-replacing write and goes through the SAME
        // validate pass as every other one (rule 1: the replacement must be a
        // superset of everything still true; CAS-stamped) before it touches
        // the ledger. SUPERSEDE only disables an older duplicate — direct.
        const merges: Array<{ finding: AuditFinding; absorb: string[] }> = [];
        const supersede = (oldId: string, byId: string) =>
          this.lorebook.withRevisionContext(revisionCtx, () => supersedeOffscreenEntry(this.lorebook, run.userId, oldId, byId, run.campaignId));
        for (const op of Array.isArray(offOps) ? offOps : []) {
          if (op?.op === "SUPERSEDE" && op.entry_id && op.by && ledgerById.has(op.entry_id) && ledgerById.has(op.by) && op.entry_id !== op.by && !consumed.has(op.entry_id)) {
            // Newest-wins guard: the surviving entry must be newer than the one it replaces.
            if (ledgerById.get(op.by)!.createdAt < ledgerById.get(op.entry_id)!.createdAt) continue;
            const replaced = this.lorebook.transact(() => {
              assertSource();
              for (const id of [op.entry_id!, op.by!]) {
                const live = this.lorebook.findById(run.userId, id);
                if (!live || canonSourceVersion(live) !== ledgerSourceVersions.get(id)) return false;
              }
              return supersede(op.entry_id!, op.by!);
            });
            if (replaced) {
              consumed.add(op.entry_id);
              offscreenReconciled++;
            }
          } else if (op?.op === "MERGE" && op.keep_id && ledgerById.has(op.keep_id) && typeof op.content === "string" && op.content.length > 0 && Array.isArray(op.absorb_ids) && !consumed.has(op.keep_id)) {
            const absorb = op.absorb_ids.filter((id) => ledgerById.has(id) && id !== op.keep_id && !consumed.has(id)
              && ledgerById.get(op.keep_id!)!.createdAt >= ledgerById.get(id)!.createdAt);
            if (absorb.length === 0) continue;
            consumed.add(op.keep_id); // one merge per keep_id this run — no double-merge
            const keep = ledgerById.get(op.keep_id)!;
            merges.push({
              absorb,
              finding: {
                kind: "stale",
                summary: `Offscreen MERGE into ${keep.name} (absorbing ${absorb.length} older ledger entr${absorb.length === 1 ? "y" : "ies"})`,
                detail: op.reason ? String(op.reason) : undefined,
                entryIds: absorb,
                op: { op: "UPDATE", entry_id: op.keep_id, content: op.content, basis: `offscreen ledger merge: ${op.reason ?? "newest-wins fold of older variants"}` },
              },
            });
          } else if (op?.op === "FLAG" && op.claim && Array.isArray(op.entry_ids)) {
            const ids = op.entry_ids.filter((id) => ledgerById.has(id));
            if (ids.length === 0) continue;
            const finding: AuditFinding = { kind: "contradiction", summary: `Offscreen: ${op.claim}`, detail: op.detail, entryIds: ids };
            flagged.push({ text: `contradiction (offscreen, unresolved: ${(op.detail ?? "irreconcilable offscreen facts").slice(0, 120)}): ${finding.summary}`, finding, reason: (op.detail ?? "genuinely different irreconcilable offscreen facts").slice(0, 600) });
          }
        }
        if (merges.length > 0) {
          const validated = new Set(await this.verdictPass(runtime, modelId, run, merges.map((m) => m.finding), "validate", VALIDATE_SYSTEM, VALIDATE_BATCH, flagged, refuted, signal, usage, effortDial, inputs, details.openaiFastMode));
          const offscreenToEmbed: Array<{ id: string; userId: string; content: string }> = [];
          for (const m of merges) {
            if (!validated.has(m.finding) || !m.finding.op?.entry_id) continue;
            const { appliedDetails, toEmbed, conflicts } = this.lorebook.transact(() => {
              const result = this.applyOps(revisionCtx, run.userId, run.campaignId, [m.finding.op!]);
              if (result.appliedDetails.length > 0) {
                for (const id of m.absorb) {
                  if (!supersede(id, m.finding.op!.entry_id!)) throw new Error("offscreen merge source changed before supersede");
                }
              }
              return result;
            });
            if (appliedDetails.length === 0) {
              // CAS conflict or the keep entry left the ledger mid-run: skip —
              // the next audit re-derives the merge from the live ledger.
              if (conflicts.length > 0) recordSystemEvent({ userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
                message: "offscreen merge held because a source entry changed after validation — all source canon preserved", details: { runId: run.id, keepId: m.finding.op.entry_id, sourceIds: m.absorb } });
              continue;
            }
            offscreenToEmbed.push(...toEmbed);
            for (const id of m.absorb) {
              consumed.add(id);
              offscreenReconciled++;
            }
          }
          if (offscreenToEmbed.length > 0) await this.reembed(run, offscreenToEmbed, embedModelId, "offscreen merge re-embed");
        }
        if (offscreenReconciled > 0) {
          this.logger.info({ runId: run.id, campaignId: run.campaignId, reconciled: offscreenReconciled, ledger: offscreenActive.length }, "offscreen coherence pass reconciled ledger entries");
        }
      }

      // ── Adversarial tail ───────────────────────────────────────────────────
      const survivors = await this.verdictPass(runtime, modelId, run, findings, "refute", REFUTE_SYSTEM, REFUTE_BATCH, flagged, refuted, signal, usage, effortDial, inputs, details.openaiFastMode);

      // Coverage findings already carry a concrete op. Contradiction/stale
      // findings don't — instead of blanket-flagging them (the old "never-guess"
      // gate), run them through the RESOLVER: it authors a transcript-grounded
      // corrective op where the evidence is unambiguous, else flags. Resolver
      // outputs join the op stream for validation + auto-apply; unresolved ones
      // are flagged (and surfaced via system_event below).
      const opFindings = survivors.filter((f) => f.op);
      const contradictions = survivors.filter((f) => !f.op);
      const resolved = await this.resolvePass(runtime, modelId, run, contradictions, flagged, signal, usage, effortDial, inputs, details.openaiFastMode);
      const withOps = [...opFindings, ...resolved];

      const validated = await this.verdictPass(runtime, modelId, run, withOps, "validate", VALIDATE_SYSTEM, VALIDATE_BATCH, flagged, refuted, signal, usage, effortDial, inputs, details.openaiFastMode);

      // ── Caps + apply ───────────────────────────────────────────────────────
      const opToFinding = new Map(validated.filter((f) => f.op).map((f) => [f.op!, f]));
      const finalOps = validated.map((f) => f.op!).filter(Boolean);
      const { allowed, held } = applyOpClassCaps(finalOps, tailEntries.length);
      if (held.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "campaign_audit", severity: "warn", campaignId: run.campaignId,
          message: `campaign audit blast-radius cap tripped — ${held.map((h) => `${h.opClass}×${h.count}`).join(", ")} held, not applied`,
          details: { runId: run.id, held },
        });
      }

      details.progress = { stage: "apply", current: 0, total: allowed.length };
      this.persist(run.id, details);
      const first = this.applyOps(revisionCtx, run.userId, run.campaignId, allowed);
      const appliedDetails = [...first.appliedDetails];
      const toEmbed = [...first.toEmbed];
      const writeNotes = emptyApplyNotes();
      addApplyNotes(writeNotes, first.notes);
      if (first.conflicts.length > 0) {
        // ── Collision round ─────────────────────────────────────────────────
        // Targets changed between validation and apply (fast-lane write or a
        // user edit). ONE re-validation against the freshest content — the
        // validator re-stamps and may merge via fixedOp — then a final CAS
        // apply. Second-round conflicts are held: the next stateless audit
        // re-derives anything still true, so skips cost latency, never
        // correctness.
        const retryFindings = first.conflicts
          .map((op) => opToFinding.get(op))
          .filter((f): f is AuditFinding => Boolean(f));
        const revalidated = await this.verdictPass(runtime, modelId, run, retryFindings, "validate", VALIDATE_SYSTEM, VALIDATE_BATCH, flagged, refuted, signal, usage, effortDial, inputs, details.openaiFastMode);
        const second = this.applyOps(revisionCtx, run.userId, run.campaignId, revalidated.map((f) => f.op!).filter(Boolean));
        appliedDetails.push(...second.appliedDetails);
        toEmbed.push(...second.toEmbed);
        addApplyNotes(writeNotes, second.notes);
        if (second.conflicts.length > 0) {
          held.push(...heldByClass(second.conflicts, (n) => `${n} op(s) held after repeated mid-audit target changes (collision) — the next audit re-derives anything still true`));
        }
      }
      this.recordApplyNotes(run, "campaign audit", writeNotes);
      if (writeNotes.keyCaps.length > 0) details.keyCaps = writeNotes.keyCaps;
      held.push(...heldRefusalRows(writeNotes.held));
      // ── Same-run supersession (2026-07-21) ────────────────────────────────
      // A flag whose implicated entries were MODIFIED by ops this run applied
      // is describing pre-apply content — the resolver (or another cluster's
      // fix) already moved the ground under it, and persisting it double-
      // reports a tension the run just fixed (a clock entry is the usual case: the run
      // corrected the entry AND queued a flag about its pre-fix state).
      // Withdraw those flags from the queue; statelessness is the safety net —
      // if the tension survives the fix, the next audit re-derives it from
      // fresh content and it returns. Withdrawn flags stay in the REPORT,
      // annotated, so nothing is silently dropped.
      const modifiedEntryIds = new Set(appliedDetails
        .filter((a) => (a.op === "UPDATE" || a.op === "DISABLE") && a.entryId)
        .map((a) => a.entryId!));
      const withdrawnSet = new Set(flagged.filter((item) => (item.finding.entryIds ?? []).some((id) => modifiedEntryIds.has(id))));
      const persistedFlags = flagged.filter((item) => !withdrawnSet.has(item));
      const withdrawnFlags = flagged.filter((item) => withdrawnSet.has(item));
      const ambiguous = [
        ...persistedFlags.map((item) => item.text),
        ...withdrawnFlags.map((item) => `${item.text} — WITHDRAWN: a fix applied in this same run modified the implicated entries; re-derives next audit if still unresolved`),
      ];
      if (withdrawnFlags.length > 0) {
        this.logger.info({ runId: run.id, campaignId: run.campaignId, withdrawn: withdrawnFlags.length }, "withdrew flag(s) superseded by fixes applied in the same run");
      }
      if (toEmbed.length > 0) await this.reembed(run, toEmbed, embedModelId, "campaign_audit re-embed");

      // ── Cancel after apply ─────────────────────────────────────────────────
      // The apply rounds are committed; a Cancel that landed during the
      // re-embed or the findings tail cannot undo them. The run must not read
      // "canceled" with pre-apply details: record the report on the row it
      // has, say what stood, and leave the ⚖ queue untouched (a canceled run
      // rewrites nothing there — the next audit re-derives).
      const canceledAfterApply = () => Boolean(signal?.aborted) || this.runs.findById(run.userId, run.id)?.status === "canceled";
      const evidenceCost = this.evidenceStatsFor(run.campaignId);
      const buildReport = (): CampaignAuditReport => ({
        analysis,
        applied: {
          creates: appliedDetails.filter((a) => a.op === "CREATE").length,
          updates: appliedDetails.filter((a) => a.op === "UPDATE").length,
          disables: appliedDetails.filter((a) => a.op === "DISABLE").length,
        },
        appliedDetails,
        held,
        refuted,
        ambiguous,
        stats: { findings: findings.length, phase1Chunks, phase2Clusters: clusters.length, messagesRead, entriesRead: allEntries.length, offscreenReconciled, evidenceSearches: evidenceCost.searches, evidenceMs: Math.round(evidenceCost.totalMs), evidenceMaxMs: Math.round(evidenceCost.maxMs) },
        usage: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, elapsedMs: Math.max(0, Date.now() - startMs) },
        resumedFrom: details.resumeAttempts ? `resumed (${details.resumeAttempts} prior attempt${details.resumeAttempts === 1 ? "" : "s"})` : (details.seededFrom ?? null),
      });
      const recordCanceledAfterApply = (stage: string) => {
        delete details.checkpoint;
        delete details.usageCarry;
        details.progress = undefined;
        details.report = buildReport();
        // Unconditional: the row is terminal (canceled); only its details change.
        this.runs.updateRun(run.id, { detailsJson: JSON.stringify(details), summary: `Campaign audit canceled ${stage} — ${appliedDetails.length} change(s) had already applied and stand (revisioned); report recorded, flagged findings not persisted` });
        recordSystemEvent({
          userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
          message: `campaign audit was canceled ${stage}: ${appliedDetails.length} applied change(s) stand (revertible per entry via lorebook History); the report was recorded on the canceled run; flagged findings were not persisted and re-derive next audit`,
          details: { runId: run.id, applied: appliedDetails.map((a) => `${a.op} ${a.name}`).slice(0, 25) },
        });
      };
      if (canceledAfterApply()) { recordCanceledAfterApply("after its changes applied"); return; }

      // ── Flag surfacing (review queue) ─────────────────────────────────────
      // Persist the structured residue for the composer Findings queue (the
      // report strings survive for the dialog, but rulings need the real
      // finding: kind, entry ids, the resolver's reason). Fingerprint dedupe
      // absorbs re-derivations across stateless runs. Then emit the warn
      // system_event so an auto run's flags can't sit silent.
      // Withdrawn flags are deliberately EXCLUDED from the active-fingerprint
      // set: an older open row for the same tension is equally superseded by
      // the same-run fix, so autoCloseStale sweeps it too (re-derivation
      // brings back anything still real).
      const activeFingerprints = new Set(persistedFlags.map((item) => fingerprintFinding({ kind: item.finding.kind, summary: item.finding.summary, entryIds: item.finding.entryIds })));
      const staleClosed = this.lorebook.transact(() => {
        assertSource();
        const flagNow = new Date().toISOString();
        const closed = this.findingsRepo.autoCloseStale(run.userId, run.campaignId, activeFingerprints, details.mode, flagNow);
        for (const item of persistedFlags) {
          this.findingsRepo.upsertFlagged({
            userId: run.userId, campaignId: run.campaignId, runId: run.id,
            kind: item.finding.kind, summary: item.finding.summary,
            detail: item.finding.detail ?? null, reason: item.reason,
            entryIds: item.finding.entryIds ?? [],
          }, flagNow);
        }
        return closed;
      });
      if (staleClosed > 0) this.logger.info({ runId: run.id, campaignId: run.campaignId, closed: staleClosed }, "auto-closed stale findings the latest audit no longer detects");
      if (persistedFlags.length > 0) {
        recordSystemEvent({
          userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
          message: `campaign audit flagged ${persistedFlags.length} finding(s) for your ruling — open the ⚖ Findings chip in the composer to rule on them`,
          details: { runId: run.id, flagged: persistedFlags.map((item) => item.text).slice(0, 25), withdrawnSameRun: withdrawnFlags.length },
        });
      }

      // ── Report ─────────────────────────────────────────────────────────────
      const report = buildReport();
      delete details.checkpoint;
      delete details.usageCarry;
      details.progress = undefined;
      details.report = report;
      const doneAt = new Date().toISOString();
      const summary = `Campaign audit (${details.mode}${details.auto ? ", auto" : ""}): ${appliedDetails.length} applied (${report.applied.creates}c/${report.applied.updates}u/${report.applied.disables}d), ${refuted.length} refuted, ${persistedFlags.length} flagged${withdrawnFlags.length > 0 ? `, ${withdrawnFlags.length} withdrawn (superseded by same-run fixes)` : ""}${offscreenReconciled > 0 ? `, ${offscreenReconciled} offscreen reconciled` : ""}${held.length ? `, ${held.map((h) => `${h.count} ${h.opClass}s HELD`).join(" + ")}` : ""}.`;
      // Guarded completion: a cancel between the findings
      // transaction and here leaves the row canceled — record the report on
      // it and never stamp approvedAt on a run that did not complete.
      if (!this.runs.markCompleted(run.id, doneAt, summary, JSON.stringify(details))) { recordCanceledAfterApply("during its final report"); return; }
      this.runs.updateRun(run.id, { approvedAt: doneAt });
      this.logger.info({ runId: run.id, campaignId: run.campaignId, mode: details.mode, applied: appliedDetails.length, refuted: refuted.length, flagged: persistedFlags.length, withdrawn: withdrawnFlags.length, calls: usage.calls }, "campaign audit completed");
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", this.runs.getDetailsJson(run.id) ?? run.detailsJson ?? null);
        return;
      }
      const msg = error instanceof Error ? error.message : "campaign audit failed";
      // Resume-on-failure: a transient error (rate-limit / overload / network /
      // hung call — the Max-window class) requeues WITH the checkpoint instead of
      // failing, so the tokens already spent aren't wasted. Bounded by the resume
      // cap; the cooldown ladder gives the window time to clear.
      let priorAttempts = 0;
      try {
        const details = (run.detailsJson ? JSON.parse(run.detailsJson) : {}) as AuditDetails;
        const attempts = details.resumeAttempts ?? 0;
        priorAttempts = attempts;
        // A resumable death WITHOUT a checkpoint (e.g. the first map call blew
        // the deadline) previously fell through to a TERMINAL fail — a fresh
        // cooled-down restart still beats terminal death, and the attempt cap
        // bounds the retries either way.
        if (isResumableError(error, signal)) {
          const latest = this.runs.getDetailsJson(run.id); // pick up the freshest checkpoint the run persisted
          const merged = (latest ? JSON.parse(latest) : details) as AuditDetails;
          // Progress-aware attempts: the cap bounds CONSECUTIVE
          // no-progress failures (a genuinely wedged call), not lifetime
          // hiccups — a 10-hour full audit on a huge campaign legitimately
          // eats several transients while its checkpoint advances every time.
          const sig = checkpointSignature(merged.checkpoint);
          const nextAttempts = nextResumeAttempts(attempts, merged.lastFailureSig, sig);
          if (nextAttempts <= MAX_RESUME_ATTEMPTS) {
            merged.resumeAttempts = nextAttempts;
            merged.lastFailureSig = sig;
            const notBefore = new Date(Date.now() + resumeCooldownMs(nextAttempts - 1)).toISOString();
            if (!this.runs.requeueForResume(run.id, notBefore, JSON.stringify(merged))) return;
            recordSystemEvent({
              userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
              message: `campaign audit hit a transient error (attempt ${nextAttempts}/${MAX_RESUME_ATTEMPTS}${nextAttempts === 1 && attempts > 0 ? ", streak reset on checkpoint progress" : ""}); requeued${merged.checkpoint ? " with its checkpoint — no work lost" : " for a fresh cooled-down restart"}, resumes after ${Math.round(resumeCooldownMs(nextAttempts - 1) / 60_000)}m: ${msg.slice(0, 120)}`,
              details: { runId: run.id, notBefore, attempts: nextAttempts, hasCheckpoint: Boolean(merged.checkpoint) },
            });
            return;
          }
        }
      } catch { /* fall through to terminal fail */ }
      // No-silent-failures: markFailed records the error system_event itself
      // (source `campaign_audit`, the one shared failure path; the
      // worker-side event here used to make every terminal death a double
      // row). The resume context rides in the summary so the single event
      // still says WHY it is terminal.
      const terminal = priorAttempts > 0 ? `${msg} (terminal after ${priorAttempts} resume attempt${priorAttempts === 1 ? "" : "s"} — resume cap or non-transient error)` : msg;
      this.runs.markFailed(run.id, new Date().toISOString(), terminal, this.runs.getDetailsJson(run.id) ?? run.detailsJson ?? null);
    }
  }

  /** Execute owner rulings on flagged findings (`audit_ruling`).
   *  The ruling is AUTHORITY over what is true; the executor translates it
   *  into minimal lorebook ops via two passes (plan targets with a catalog →
   *  author with full current content), then the SAME validate/caps/apply
   *  machinery as the audit — the validator still protects HOW (no op may
   *  silently lose unrelated facts), every write is revisioned. A ruling that
   *  can't be implemented safely BOUNCES back open with one specific question
   *  (never-guess applies to rulings too). The transcript is never edited —
   *  leave-alone rulings land as canon-notes in entry content so the next
   *  (stateless) audit reads the ruling instead of re-flagging. A failed run
   *  releases its findings back to the queue with the ruling text preserved. */
  async runRuling(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    this.evidenceStats.set(run.campaignId, { searches: 0, totalMs: 0, maxMs: 0 });
    const startedAt = new Date().toISOString();
    // Scoped per write batch (see execute()): this instance is
    // shared with the slow-lane audit, whose apply may land hours later.
    const revisionCtx = { source: "campaign_audit_ruling", pipelineRunId: run.id } as const;
    const usage: UsageTally = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let ruledCount = 0;
    let bouncedCount = 0;
    const appliedTotal: Array<{ op: string; entryId: string | null; name: string }> = [];
    const rulingKeyCaps: KeyCapNote[] = [];
    try {
      const rows = this.findingsRepo.listByRulingRun(run.id);
      if (rows.length === 0) { this.runs.markFailed(run.id, startedAt, "no findings attached to this ruling run", run.detailsJson ?? null); return; }
      const details = (run.detailsJson ? JSON.parse(run.detailsJson) : {}) as { auditModel?: string; embeddingModel?: string; workerEffort?: string; openaiFastMode?: boolean };
      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) {
        this.findingsRepo.reopenByRulingRun(run.id, new Date().toISOString());
        this.runs.markFailed(run.id, startedAt, "no chat runtime available", run.detailsJson ?? null);
        return;
      }
      // Same loud resolution as the audit: the catch below
      // releases the findings and fails the run with the dial named.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "campaign_audit", "ruling executor", details.auditModel, getConfiguredDefaultModelId() ?? "claude-opus-4-6-bridge");
      const embedModelId = details.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);
      const effortDial = details.workerEffort ?? null;
      // Eligible targets = the audit's own editable set (enabled, non-constant,
      // non-tracker; sealed excluded at the repository chokepoint).
      const allEntries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId)
        .filter((e) => !e.isConstant && e.tag !== "threads");
      const entryById = new Map(allEntries.map((e) => [e.id, e]));

      const bounceRow = (id: string, question: string) => {
        this.findingsRepo.bounce(id, question.slice(0, 500), new Date().toISOString());
        bouncedCount += 1;
      };

      // ── PLAN: one call — which entries does each ruling touch? ────────────
      const catalog = allEntries.map((e) => {
        let keys: string[] = [];
        try { keys = JSON.parse(e.keys); } catch { /* name only */ }
        return `${e.id} | ${e.name} | ${e.tag ?? "-"} | ${keys.slice(0, 6).join(", ")}`;
      }).join("\n");
      const renderedRulings: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (i > 0) await yieldToEventLoop();
        renderedRulings.push(this.renderRulingForPlan(rows[i]!, i, run.userId, run.campaignId));
      }
      const rulingBlocks = renderedRulings.join("\n\n──────\n\n");
      this.runs.heartbeat(run.id);
      const planText = await this.callModel(runtime, modelId, RULING_PLAN_SYSTEM, `<entry_catalog>\n${catalog}\n</entry_catalog>\n\n${rulingBlocks}`, `campaign-audit-ruling-${run.id}-plan`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
      const plan = parseFirstJson<{ plans?: Array<{ index?: number; action?: string; question?: string; targetEntryIds?: string[]; intent?: string }> }>(planText, "{");
      const planByIndex = new Map<number, { action?: string; question?: string; targetEntryIds?: string[]; intent?: string }>();
      for (const p of Array.isArray(plan?.plans) ? plan!.plans : []) {
        if (typeof p?.index === "number") planByIndex.set(p.index, p);
      }

      const opRows: Array<{ row: AuditFindingRow; index: number; targets: Array<(typeof allEntries)[number]> }> = [];
      rows.forEach((row, i) => {
        const p = planByIndex.get(i);
        if (!p || (p.action !== "ops" && p.action !== "clarify")) {
          bounceRow(row.id, "the executor returned no usable plan for this ruling — try rephrasing it");
          return;
        }
        if (p.action === "clarify") {
          bounceRow(row.id, p.question?.trim() || "the executor needs a more specific ruling");
          return;
        }
        const wanted = [...new Set([...(Array.isArray(p.targetEntryIds) ? p.targetEntryIds : []), ...parseEntryIds(row.entryIds)])].slice(0, 30);
        const targets = wanted.map((id) => entryById.get(id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
        if (targets.length === 0) {
          bounceRow(row.id, "none of the entries this ruling touches are editable anymore (removed or protected since the flag) — re-run an audit, or point the ruling at current entries");
          return;
        }
        opRows.push({ row, index: i, targets });
      });

      // ── EXECUTE: one call — author the ops with full content in hand ──────
      if (opRows.length > 0) {
        const executeBlocks = opRows.map(({ row, index, targets }) => {
          const targetsBlock = targets.map((e) => `### id=${e.id} | ${e.name}\n${e.content}`).join("\n\n");
          return `RULING ${index} — finding (${row.kind}): ${row.summary}\nOWNER RULING: ${row.ruling ?? ""}\nplanned intent: ${planByIndex.get(index)?.intent ?? "-"}\n\n<target_entries>\n${targetsBlock}\n</target_entries>`;
        }).join("\n\n──────\n\n");
        this.runs.heartbeat(run.id);
        const execText = await this.callModel(runtime, modelId, RULING_EXECUTE_SYSTEM, executeBlocks, `campaign-audit-ruling-${run.id}-execute`, signal, usage, () => this.runs.heartbeat(run.id), effortDial, details.openaiFastMode);
        const exec = parseFirstJson<{ results?: Array<{ index?: number; ops?: AuditOp[]; outcome?: string }> }>(execText, "{");
        const resultByIndex = new Map<number, { ops?: AuditOp[]; outcome?: string }>();
        const duplicateResults = new Set<number>();
        for (const r of Array.isArray(exec?.results) ? exec!.results : []) {
          if (typeof r?.index === "number") {
            if (resultByIndex.has(r.index)) duplicateResults.add(r.index);
            resultByIndex.set(r.index, r);
          }
        }
        for (const index of duplicateResults) resultByIndex.delete(index);

        for (const { row, index, targets } of opRows) {
          if (signal?.aborted) throw abortError();
          const result = resultByIndex.get(index);
          if (!result || !Array.isArray(result.ops)) { bounceRow(row.id, "the executor returned no valid operations array for this ruling — submit it again"); continue; }
          const targetIds = new Set(targets.map((t) => t.id));
          const ops = (Array.isArray(result.ops) ? result.ops : []).filter((o) => o && (
            (o.op === "UPDATE" && o.entry_id && targetIds.has(o.entry_id) && typeof o.content === "string" && o.content.length > 0) ||
            (o.op === "CREATE" && o.name && typeof o.content === "string" && o.content.length > 0) ||
            (o.op === "DISABLE" && o.entry_id && targetIds.has(o.entry_id))
          ));
          if (ops.length !== result.ops.length || (ops.length === 0 && (typeof result.outcome !== "string" || !result.outcome.trim()))) {
            bounceRow(row.id, "the executor returned malformed/invalid-target operations or no explicit no-change explanation — submit it again");
            continue;
          }
          if (ops.length === 0) {
            const outcome = `no lorebook change needed — ${result.outcome}`;
            this.findingsRepo.markRuled(row.id, outcome.slice(0, 700), new Date().toISOString());
            ruledCount += 1;
            continue;
          }
          const rowKind = (row.kind === "coverage" || row.kind === "stale" ? row.kind : "contradiction") as AuditFinding["kind"];
          const opFindings: AuditFinding[] = ops.map((op) => ({
            kind: rowKind,
            summary: `OWNER RULING on: ${row.summary}`,
            detail: `owner ruling (authoritative): ${row.ruling ?? ""}`,
            entryIds: op.entry_id ? [op.entry_id] : [],
            op,
          }));
          const flaggedSink: FlaggedItem[] = [];
          const refutedSink: Array<{ finding: string; reason: string }> = [];
          const validated = await this.verdictPass(runtime, modelId, run, opFindings, "validate", VALIDATE_SYSTEM, VALIDATE_BATCH, flaggedSink, refutedSink, signal, usage, effortDial, undefined, details.openaiFastMode);
          const { allowed, held } = applyOpClassCaps(validated.map((f) => f.op!).filter(Boolean), allEntries.length);
          const { appliedDetails, toEmbed, conflicts, notes: applyNotes } = this.applyOps(revisionCtx, run.userId, run.campaignId, allowed);
          if (toEmbed.length > 0) await this.reembed(run, toEmbed, embedModelId, "audit_ruling re-embed");
          this.recordApplyNotes(run, "ruling executor", applyNotes);
          rulingKeyCaps.push(...applyNotes.keyCaps);
          if (appliedDetails.length > 0) {
            const notes: string[] = [];
            if (refutedSink.length > 0) notes.push(`${refutedSink.length} op(s) rejected by the validator`);
            if (held.length > 0) notes.push(`${held.map((h) => `${h.count} ${h.opClass}s`).join(", ")} held by the blast-radius cap`);
            if (conflicts.length > 0) notes.push(`${conflicts.length} op(s) skipped — the entry changed mid-execution`);
            if (applyNotes.retagged.length > 0) notes.push(`reserved tag on ${applyNotes.retagged.join(", ")} filed as "events"`);
            if (applyNotes.held.length > 0) notes.push(`${applyNotes.held.length} op(s) held: ${describeHeldOps(applyNotes.held)}`);
            const outcome = `${appliedDetails.length} change(s) applied: ${appliedDetails.map((a) => `${a.op} ${a.name}`).join(", ")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""} — revertible per entry via lorebook History`;
            this.findingsRepo.markRuled(row.id, outcome.slice(0, 900), new Date().toISOString());
            ruledCount += 1;
            appliedTotal.push(...appliedDetails);
          } else {
            const why = conflicts.length > 0
              ? "the target entries changed while the ruling was executing — resubmit against the current content"
              : applyNotes.held.length > 0
                ? `${describeHeldOps(applyNotes.held)}${applyNotes.held.some((h) => h.reason === "archive-trigger") ? " (an archive trigger is the only way its cold rows come back into context; restore or re-parent them by hand first)" : ""}`
              : refutedSink[0]?.reason
                ?? (held.length > 0 ? "held by the blast-radius cap — narrow the scope or split the ruling" : flaggedSink[0]?.text ?? "the authored change could not be validated");
            bounceRow(row.id, `couldn't apply safely: ${why} — refine the ruling?`);
          }
        }
      }

      const doneAt = new Date().toISOString();
      const summary = `Audit rulings: ${ruledCount} ruled (${appliedTotal.length} lorebook change(s)), ${bouncedCount} bounced with a question.`;
      this.runs.markCompleted(run.id, doneAt, summary, JSON.stringify({ ...details, usage, applied: appliedTotal, ruled: ruledCount, bounced: bouncedCount, ...(rulingKeyCaps.length > 0 ? { keyCaps: rulingKeyCaps } : {}) }));
      recordSystemEvent({
        userId: run.userId, source: "campaign_audit", severity: bouncedCount > 0 ? "warn" : "info", campaignId: run.campaignId,
        message: `ruling executor: ${summary}${bouncedCount > 0 ? " Open the ⚖ Findings chip to answer." : ""}`,
        details: { runId: run.id },
      });
      this.logger.info({ runId: run.id, campaignId: run.campaignId, ruled: ruledCount, bounced: bouncedCount, applied: appliedTotal.length, calls: usage.calls }, "audit ruling run completed");
    } catch (error) {
      // Release the queue first — nothing may stay stuck in 'processing'. Ops
      // already applied for earlier rulings stand (each is revisioned).
      const reopenNow = new Date().toISOString();
      const reopened = this.findingsRepo.reopenByRulingRun(run.id, reopenNow);
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, reopenNow, "pipeline run canceled", null);
        return;
      }
      const msg = error instanceof Error ? error.message : "audit ruling run failed";
      // markFailed records the single error system_event (source
      // `campaign_audit` for the audit family); the release count
      // rides in the summary so that one event still tells the owner the
      // queue was released and the ruling text kept.
      this.runs.markFailed(run.id, reopenNow, `${msg} (${reopened} finding(s) released back to the queue; your ruling text is preserved)`, run.detailsJson ?? null);
    }
  }

  private renderRulingForPlan(row: AuditFindingRow, index: number, userId: string, campaignId: string): string {
    const involvedIds = parseEntryIds(row.entryIds);
    const involved = involvedIds.map((id) => this.lorebook.findById(userId, id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
    const involvedBlock = involved.map((e) => `### id=${e.id} | ${e.name}${e.isConstant || e.tag === "threads" ? " [PROTECTED]" : ""}\n${e.content.slice(0, 2000)}`).join("\n\n") || "(the implicated entries no longer exist)";
    const terms = [...new Set(involved.flatMap((e) => {
      let keys: string[] = [];
      try { keys = JSON.parse(e.keys); } catch { /* name only */ }
      return [e.name, ...keys.slice(0, 4)];
    }))].slice(0, 10).join(" ");
    const evidence = terms ? this.searchEvidence(userId, campaignId, terms, 6) : [];
    const evidenceLines = renderEvidenceExcerpts(evidence, 300);
    const evidenceBlock = evidenceLines.length > 0 ? evidenceLines.join("\n") : "(no transcript evidence found)";
    return `RULING ${index} — finding (${row.kind}): ${row.summary}${row.detail ? `\n${row.detail}` : ""}${row.reason ? `\nwhy it was flagged: ${row.reason}` : ""}\n\n<implicated_entries>\n${involvedBlock}\n</implicated_entries>\n\n<transcript_evidence relevance_selected_story_order>\n${evidenceBlock}\n</transcript_evidence>\n\nOWNER RULING: ${row.ruling ?? ""}`;
  }

  /** Timed transcript-evidence search. Synchronous by nature (better-sqlite3),
   *  so a slow one blocks the worker loop: every search is measured into the
   *  run's report, and one over 2 s is logged with its term count. */
  private searchEvidence(userId: string, campaignId: string, terms: string, limit: number) {
    const started = performance.now();
    const hits = this.messages.searchFtsForCampaign(userId, campaignId, terms, limit);
    const ms = performance.now() - started;
    const stats = this.evidenceStatsFor(campaignId);
    stats.searches += 1;
    stats.totalMs += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (ms > 2_000) this.logger.warn({ campaignId, ms: Math.round(ms), terms: terms.split(/\s+/).length }, "slow audit evidence search");
    return hits;
  }

  /** One adversarial pass over findings in batches. Verdicted-ok survive;
   *  verdicted-not-ok land in `refuted`; UNVERDICTED (missing index /
   *  unparseable batch) land in `ambiguous` — flagged, never applied. */
  private async verdictPass(runtime: ChatRuntime, modelId: string, run: { id: string; userId: string; campaignId: string; detailsJson?: string | null }, findings: AuditFinding[], stage: "refute" | "validate", system: string, batchSize: number, flagged: FlaggedItem[], refuted: Array<{ finding: string; reason: string }>, signal?: AbortSignal, tally?: UsageTally, effortDial?: string | null, inputs?: PipelineTranscriptInput, openaiFastMode?: boolean | null): Promise<AuditFinding[]> {
    const survivors: AuditFinding[] = [];
    const batches: AuditFinding[][] = [];
    for (let i = 0; i < findings.length; i += batchSize) batches.push(findings.slice(i, i + batchSize));
    let unverdictedCount = 0;
    for (let b = 0; b < batches.length; b++) {
      if (signal?.aborted) throw abortError();
      const batch = batches[b]!;
      // One finding at a time with a yield between (2026-09-27): each rendering
      // runs a synchronous evidence search, and a whole batch in one map held
      // the worker loop — heartbeats, the fast lane — until the last one ended.
      const rendered: string[] = [];
      for (let i = 0; i < batch.length; i++) {
        if (i > 0) await yieldToEventLoop();
        rendered.push(this.renderFindingForPass(batch[i]!, i, run.userId, run.campaignId, stage, settledSourceForRun(run), inputs));
      }
      const items = rendered.join("\n\n");
      this.runs.heartbeat(run.id);
      this.persistTranscriptInputs(run.id, inputs);
      const details = { stage, current: b + 1, total: batches.length };
      this.persistProgress(run.id, details);
      const text = await this.callModel(runtime, modelId, system, items, `campaign-audit-${run.id}-${stage}-${b}`, signal, tally, () => this.runs.heartbeat(run.id), effortDial, openaiFastMode);
      const verdicts = parseVerdicts(text);
      batch.forEach((f, i) => {
        const v = verdicts.get(i);
        if (!v) {
          unverdictedCount++;
          flagged.push({ text: `unverdicted (${stage}): ${f.summary}`, finding: f, reason: `unverdicted at the ${stage} pass — the batch response carried no verdict for it` });
        } else if (v.ok) {
          if (stage === "validate" && v.fixedOp && f.op) {
            // Accept validator-corrected ops but never let it change the target
            // or escalate the op class (e.g. UPDATE→DELETE).
            const sameTarget = (v.fixedOp.entry_id ?? f.op.entry_id) === f.op.entry_id;
            const sameClass = v.fixedOp.op === f.op.op;
            if (sameTarget && sameClass && v.fixedOp.content) f.op = { ...f.op, ...v.fixedOp,
              expected_updated_at: f.op.expected_updated_at, expected_source_versions: f.op.expected_source_versions };
          }
          survivors.push(f);
        } else {
          refuted.push({ finding: f.summary, reason: v.reason ?? "refuted" });
        }
      });
    }
    if (unverdictedCount > 0) {
      recordSystemEvent({
        userId: run.userId, source: "campaign_audit", severity: "warn", campaignId: run.campaignId,
        message: `${stage} pass left ${unverdictedCount} finding(s) unverdicted — flagged, not applied`,
        details: { runId: run.id, stage },
      });
    }
    return survivors;
  }

  /** RESOLVER pass — the "automate, don't gate" upgrade. For each contradiction/
   *  stale finding (which carries NO op), pull transcript evidence and either
   *  author a grounded corrective UPDATE (→ returned for validation + auto-apply)
   *  or decline. Declined findings are flagged (never-guess preserved: the model
   *  is instructed to resolve ONLY when the transcript is unambiguous). One call
   *  per finding — findings are few relative to phase 1. */
  private async resolvePass(runtime: ChatRuntime, modelId: string, run: { id: string; userId: string; campaignId: string; detailsJson?: string | null }, findings: AuditFinding[], flagged: FlaggedItem[], signal?: AbortSignal, tally?: UsageTally, effortDial?: string | null, inputs?: PipelineTranscriptInput, openaiFastMode?: boolean | null): Promise<AuditFinding[]> {
    const resolvedOut: AuditFinding[] = [];
    for (let i = 0; i < findings.length; i++) {
      if (signal?.aborted) throw abortError();
      const f = findings[i]!;
      const entries = (f.entryIds ?? []).map((id) => this.lorebook.findById(run.userId, id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
      // Transcript evidence: FTS over the implicated entities' names + keys.
      const terms = [...new Set(entries.flatMap((e) => {
        let keys: string[] = [];
        try { keys = JSON.parse(e.keys); } catch { /* name only */ }
        return [e.name, ...keys.slice(0, 4)];
      }))].slice(0, 10).join(" ");
      const hits = terms ? this.searchEvidence(run.userId, run.campaignId, terms, 8) : [];
      const evidence = inputs ? inputs.evidence(hits) : settledEvidence(this.messages, run.userId, hits, settledSourceForRun(run));
      this.persistTranscriptInputs(run.id, inputs);
      // Full content: the resolver authors FULL-replacement UPDATEs
      // for these entries — a 2000-char view made long entries blind rewrites.
      const entriesBlock = entries.map((e) => `### id=${e.id} | ${e.name}${e.isConstant || e.tag === "threads" ? " [PROTECTED — cannot be an op target]" : ""}\n${e.content}`).join("\n\n") || "(implicated entries not found)";
      const evidenceLines = renderEvidenceExcerpts(evidence, 400);
      const evidenceBlock = evidenceLines.length ? evidenceLines.join("\n") : "(no transcript evidence found — treat as UNRESOLVABLE unless the entries alone settle it)";
      const user = `<contradiction>\n${f.summary}${f.detail ? `\n${f.detail}` : ""}\n</contradiction>\n\n<implicated_entries>\n${entriesBlock}\n</implicated_entries>\n\n<transcript_evidence relevance_selected_story_order>\n${evidenceBlock}\n</transcript_evidence>`;
      this.runs.heartbeat(run.id);
      const text = await this.callModel(runtime, modelId, RESOLVE_SYSTEM, user, `campaign-audit-${run.id}-resolve-${i}`, signal, tally, () => this.runs.heartbeat(run.id), effortDial, openaiFastMode);
      const parsed = parseFirstJson<{ resolved?: boolean; reason?: string; ops?: AuditOp[] }>(text, "{");
      const protectedIds = new Set(entries.filter((e) => e.isConstant || e.tag === "threads").map((e) => e.id));
      const validEntryIds = new Set(entries.map((e) => e.id));
      const ops = (parsed?.resolved && Array.isArray(parsed.ops)) ? parsed.ops.filter((o) =>
        o && o.op === "UPDATE" && o.entry_id && o.content && validEntryIds.has(o.entry_id) && !protectedIds.has(o.entry_id),
      ) : [];
      if (parsed?.resolved && ops.length > 0) {
        // One AuditFinding per authored op so each is validated independently.
        for (const op of ops) resolvedOut.push({ kind: f.kind, summary: `RESOLVE ${entries.find((e) => e.id === op.entry_id)?.name ?? op.entry_id}: ${f.summary}`, detail: f.detail, entryIds: f.entryIds, op: { ...op, basis: `resolver: ${f.summary}` } });
      } else {
        const reason = parsed?.reason ? String(parsed.reason) : "the transcript doesn't settle it unambiguously";
        flagged.push({
          text: `${f.kind} (unresolved: ${reason.slice(0, 120)}): ${f.summary}${f.detail ? ` — ${f.detail}` : ""}`,
          finding: f,
          reason: reason.slice(0, 600),
        });
      }
    }
    return resolvedOut;
  }

  private renderFindingForPass(f: AuditFinding, index: number, userId: string, campaignId: string, stage: "refute" | "validate", source?: ReturnType<typeof settledSourceForRun>, inputs?: PipelineTranscriptInput): string {
    const parts: string[] = [`FINDING ${index} (${f.kind}): ${f.summary}`];
    if (f.detail) parts.push(`detail: ${f.detail}`);
    if (f.basis) parts.push(`basis (from transcript): ${f.basis}`);
    if (f.op) {
      parts.push(`proposed op: ${JSON.stringify({ ...f.op, content: f.op.content, expected_updated_at: undefined, expected_source_versions: undefined })}`);
      if (stage === "validate") f.op.expected_source_versions = {};
      if (f.op.entry_id) {
        const target = this.lorebook.findById(userId, f.op.entry_id);
        // CAS stamp: record exactly the version the validator judged;
        // applyOps compare-and-swaps against it.
        if (stage === "validate" && target) {
          f.op.expected_updated_at = target.updatedAt;
          f.op.expected_source_versions![target.id] = canonSourceVersion(target);
        }
        // Whole target: the validator judges "UPDATE must be a
        // superset of everything still true" and authors fixedOp merges —
        // both need the full entry, not its first 6000 chars.
        parts.push(target ? `target entry CURRENT content: ${target.content}` : `target entry ${f.op.entry_id} NOT FOUND`);
      }
    }
    for (const id of f.entryIds ?? []) {
      if (id === f.op?.entry_id) continue; // already rendered in full as the target
      const entry = this.lorebook.findById(userId, id);
      if (entry) {
        parts.push(`entry ${id} (${entry.name}): ${entry.content}`);
        if (stage === "validate" && f.op) f.op.expected_source_versions![id] = canonSourceVersion(entry);
      } else if (stage === "validate" && f.op) {
        f.op.expected_source_versions![id] = "missing";
        parts.push(`entry ${id} NOT FOUND — cannot authorize replacing/disabling it`);
      }
    }
    // Transcript evidence for lorebook-internal findings (the refute pass only —
    // validation judges information preservation, not story truth).
    if (stage === "refute" && f.kind !== "coverage") {
      const terms = [...new Set((f.entryIds ?? []).flatMap((id) => {
        const e = this.lorebook.findById(userId, id);
        if (!e) return [];
        let keys: string[] = [];
        try { keys = JSON.parse(e.keys); } catch { /* name only */ }
        return [e.name, ...keys.slice(0, 4)];
      }))].slice(0, 8).join(" ");
      if (terms) {
        const candidates = this.searchEvidence(userId, campaignId, terms, 6);
        const hits = inputs ? inputs.evidence(candidates) : settledEvidence(this.messages, userId, candidates, source);
        const evidenceLines = renderEvidenceExcerpts(hits, 300);
        if (evidenceLines.length > 0) {
          parts.push(`transcript evidence (most relevant excerpts, story order):\n${evidenceLines.join("\n")}`);
        } else {
          parts.push("transcript evidence: none found (do not treat absence as confirmation)");
        }
      }
    }
    return parts.join("\n");
  }

  /** Synchronous write batch under a SCOPED revision context: the
   *  context is set for exactly this loop and restored after, so the shared
   *  instance can never carry one run's provenance onto another's writes. */
  private applyOps(ctx: { source: "campaign_audit" | "campaign_audit_ruling"; pipelineRunId: string; assertSource?: () => void }, userId: string, campaignId: string, ops: AuditOp[]): ApplyResult {
    return this.lorebook.withRevisionContext(ctx, () => this.lorebook.transact(() => { ctx.assertSource?.(); return this.applyOpsUnscoped(userId, campaignId, ops); }));
  }

  private applyOpsUnscoped(userId: string, campaignId: string, ops: AuditOp[]): ApplyResult {
    const now = new Date().toISOString();
    const appliedDetails: Array<{ op: string; entryId: string | null; name: string }> = [];
    const toEmbed: Array<{ id: string; userId: string; content: string }> = [];
    const notes = emptyApplyNotes();
    const keyCaps = new KeyCapNotes();
    // Targets that changed (or got archived) since the validator judged the op
    // — never written; the caller re-validates them once against fresh content.
    const conflicts: AuditOp[] = [];
    for (const op of ops) {
      if (Object.entries(op.expected_source_versions ?? {}).some(([id, version]) => {
        const live = this.lorebook.findById(userId, id);
        // An implicated sibling the validator saw as MISSING (deleted between
        // the map call and the tail) is unchanged while it stays missing;
        // it only conflicts if it reappeared. It used to count as a
        // conflict on every round, so a valid fix on the surviving entry was
        // held as "repeated mid-audit target changes".
        if (version === "missing") return Boolean(live);
        return !live || live.campaignId !== campaignId || canonSourceVersion(live) !== version;
      })) { conflicts.push(op); continue; }
      if (op.op === "CREATE" && op.name && op.content) {
        const id = createId();
        // One tag sanitizer for every machine CREATE: the reserved
        // lifecycle tags (`threads`, `archived`) fall back to `events`. A stray
        // `threads` row is frozen (the tracker only touches its own ledger and
        // every other writer refuses the tag) yet keeps activating by keyword.
        const tag = sanitizeCreateTag(op.tag);
        if (tag.retagged) notes.retagged.push(`${op.name} (${String(op.tag)})`);
        // One key rule for every worker write: trimmed, no empty
        // or case-repeated keys, at most LOREBOOK_MAX_KEYS, so no worker can
        // store a list the editor's full-payload save would reject.
        const createKeys = normalizeKeyList(op.keys ?? []);
        keyCaps.noteList(op.name, createKeys);
        this.lorebook.create({
          id, userId, campaignId, name: op.name, tag: tag.tag, content: op.content, comment: null,
          keys: JSON.stringify(createKeys.keys), keysSecondary: "[]", selectiveLogic: "and_any", scanDepth: 4,
          position: "before_main", insertionOrder: 100, probability: 100, isConstant: 0, isEnabled: 1,
          sticky: 0, cooldown: 0, delay: 0, excludeRecursion: 0, preventRecursion: 0, delayUntilRecursion: 0,
          tokensEstimate: estimateTokens(op.content),
          // Bounded like an editor's list: trimmed, no blank or repeated
          // name, at most LOREBOOK_KNOWN_BY_MAX_NAMES; an empty list is null.
          knownBy: storedKnownBy(op.known_by),
          matchOptionsJson: null, legacySource: null, createdAt: now, updatedAt: now,
        });
        toEmbed.push({ id, userId, content: op.content });
        appliedDetails.push({ op: "CREATE", entryId: id, name: op.name });
      } else if (op.op === "UPDATE" && op.entry_id && op.content) {
        const existing = this.lorebook.findById(userId, op.entry_id);
        // Held with the reason, never skipped silently (heldOps.ts vocabulary):
        // constants and `threads` entries belong to the tracker.
        const refusal = !existing ? "not-found" : existing.campaignId !== campaignId ? "other-campaign"
          : existing.isConstant ? "constant" : (existing.tag ?? "").trim().toLowerCase() === "threads" ? "thread" : null;
        if (refusal || !existing) { notes.held.push({ entryId: op.entry_id, op: "UPDATE", reason: refusal ?? "not-found" }); continue; }
        // CAS: the entry changed (or got archived) after validation —
        // a full-replacement write here would clobber newer canon.
        if (!existing.isEnabled || (op.expected_updated_at && existing.updatedAt !== op.expected_updated_at)) {
          conflicts.push(op);
          continue;
        }
        const updates: Record<string, unknown> = { content: op.content, tokensEstimate: estimateTokens(op.content), updatedAt: now };
        if (op.known_by !== undefined) updates.knownBy = storedKnownBy(op.known_by);
        // Proposed keys MERGE onto the live list; they used to
        // replace it. Neither the sweep, the resolver nor the ruling executor
        // is shown an entry's keys, so a replacement dropped curated keys the
        // model never saw (the rolling diff had the same bug). No growth cap;
        // the list cap binds, and is named in the run's details.
        if (Array.isArray(op.keys) && op.keys.length > 0) {
          const merged = mergeKeyLists(existing.keys, op.keys);
          keyCaps.noteMerge(`${existing.name} (${op.entry_id})`, merged);
          if (merged.changed) updates.keys = JSON.stringify(merged.keys);
        }
        this.lorebook.update(userId, op.entry_id, updates as never);
        toEmbed.push({ id: op.entry_id, userId, content: op.content });
        appliedDetails.push({ op: "UPDATE", entryId: op.entry_id, name: existing.name });
      } else if ((op.op === "DISABLE" || op.op === "DELETE") && op.entry_id) {
        // DELETE→DISABLE downgrade: the audit never destroys content.
        const target = this.lorebook.findById(userId, op.entry_id);
        if (!target || target.campaignId !== campaignId) {
          notes.held.push({ entryId: op.entry_id, op: "DISABLE", reason: !target ? "not-found" : "other-campaign" });
          continue;
        }
        // The one shared DISABLE predicate: the audit keeps its refute-first
        // DISABLE for every tag
        // except `threads` (the tracker's) and constants, and never disables
        // an archive trigger, whose cold rows come back into context only
        // through it (43 disabled triggers once stranded 157 cold rows on
        // one campaign). A refused DISABLE is held for hand curation.
        const refusal = workerDisableRefusal(target, "campaign_audit");
        if (refusal) { notes.held.push({ entryId: op.entry_id, op: "DISABLE", reason: refusal }); continue; }
        if (!target.isEnabled) continue; // already disabled — nothing to do
        if (op.expected_updated_at && target.updatedAt !== op.expected_updated_at) {
          conflicts.push(op);
          continue;
        }
        this.lorebook.update(userId, op.entry_id, { isEnabled: 0, updatedAt: now } as never);
        appliedDetails.push({ op: "DISABLE", entryId: op.entry_id, name: target.name });
      }
    }
    notes.keyCaps.push(...keyCaps.list());
    return { appliedDetails, toEmbed, conflicts, notes };
  }

  /** Surfaces an apply batch's notes: visible, never silent. The
   *  prompts name the allowed tags, so a model that emits a reserved one is
   *  drifting; the entry is kept under `events`. */
  private recordApplyNotes(run: { id: string; userId: string; campaignId: string }, who: string, notes: ApplyNotes): void {
    if (notes.held.length > 0) {
      recordSystemEvent({
        userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
        message: `${who} held ${notes.held.length} operation(s) at the write: ${describeHeldOps(notes.held)}; the existing entries were kept${notes.held.some((h) => h.reason === "archive-trigger") ? " (an archive trigger is the only way its cold rows come back into context; re-parent or restore them by hand before disabling it)" : ""}`,
        details: { runId: run.id, held: notes.held, byReason: countHeldByReason(notes.held) },
      });
    }
    if (notes.retagged.length > 0) {
      recordSystemEvent({
        userId: run.userId, source: "campaign_audit", severity: "info", campaignId: run.campaignId,
        message: `${who} CREATE used a reserved tag on ${notes.retagged.length} entr${notes.retagged.length === 1 ? "y" : "ies"}, filed under "events" instead: ${notes.retagged.join(", ")}`,
        details: { runId: run.id, retagged: notes.retagged },
      });
    }
  }

  private async callModel(runtime: ChatRuntime, modelId: string, systemPrompt: string, user: string, requestId: string, signal?: AbortSignal, tally?: UsageTally, heartbeat?: () => void, effortDial?: string | null, openaiFastMode?: boolean | null): Promise<string> {
    if (/-(validate|resolve|refine|offscreen|execute)(-|$)/.test(requestId) && user.length > 400_000) {
      throw new Error("complete canon preservation evidence exceeds the 400000-character worker budget — changes held instead of truncating facts");
    }
    let text = "";
    const effort = workerEffortFor(modelId, effortDial);
    // Wall-clock liveness, independent of streaming: a max-effort
    // call can legally reason for long stretches emitting NO text/thinking
    // deltas (sidecar keepalives hold the socket open without producing
    // events), so a delta-driven beat starves and the 60-min stale sweeps
    // reap a perfectly healthy call. Beat on TIME while
    // the call is in flight; the per-call deadline still governs true zombies.
    // A failed beat is logged, never swallowed: one audit's beats once stopped
    // landing for an hour with no trace before the sweep reaped it.
    // The main loop's touchActiveRuns now keeps the run live regardless; this
    // line is the evidence if a stage beat breaks again.
    const beatTimer = heartbeat ? setInterval(() => {
      try { heartbeat(); } catch (err) {
        const now = Date.now();
        if (now - this.lastBeatFailureLogAt > 5 * 60_000) {
          this.lastBeatFailureLogAt = now;
          this.logger.warn({ err, requestId }, "audit call heartbeat failed (the worker loop's liveness touch still covers the run)");
        }
      }
    }, AUDIT_CALL_HEARTBEAT_MS) : null;
    try {
    await withDeadline(AUDIT_LLM_DEADLINE_MS, `campaign_audit call (${requestId})`, (dl) => withRetry(() => runtime.streamChat({
      modelId, systemPrompt,
      messages: [{ role: "user", content: user, attachments: [] }],
      temperature: 0, thinkingMode: workerThinkingModeFor(modelId, effort), thinkingBudget: null, effort, cacheTtl: "off",
      // Engine dial (2026-09-09): OpenAI fast mode where the audit model supports it.
      speed: openaiFastModeFor(modelId, openaiFastMode),
      requestId, signal: dl,
    }, { onStart: () => {}, onDelta: (d) => { text += d; }, onThinkingDelta: () => {}, onComplete: (r) => {
      if (tally) {
        tally.calls += 1;
        tally.inputTokens += r.usage.inputTokens ?? 0;
        tally.outputTokens += r.usage.outputTokens ?? 0;
        tally.cacheReadTokens += r.usage.cacheReadTokens ?? 0;
      }
    } }), () => { text = ""; }, signal), signal);
    } finally {
      if (beatTimer) clearInterval(beatTimer);
    }
    return text;
  }

  private persist(runId: string, details: AuditDetails) {
    this.runs.updateRun(runId, { detailsJson: JSON.stringify(details), updatedAt: new Date().toISOString() });
  }

  /** Save newly selected evidence before its model await without overwriting
   * another stage's checkpoint/progress fields. */
  private persistTranscriptInputs(runId: string, inputs?: PipelineTranscriptInput): void {
    if (!inputs?.source) return;
    this.lorebook.transact(() => {
      inputs.assertCurrent();
      const details = JSON.parse(this.runs.getDetailsJson(runId) ?? "{}");
      details.transcriptInput = inputs.manifest;
      this.runs.updateRun(runId, { detailsJson: JSON.stringify(details), updatedAt: new Date().toISOString() });
    });
  }

  /** Progress-only update that must not clobber the checkpointed findings:
   *  read-modify-write the details JSON at the progress key. */
  private persistProgress(runId: string, progress: { stage: string; current: number; total: number }) {
    const current = this.runs.getDetailsJson(runId);
    if (typeof current === "string") {
      try {
        const parsed = JSON.parse(current) as AuditDetails;
        parsed.progress = progress;
        this.runs.updateRun(runId, { detailsJson: JSON.stringify(parsed), updatedAt: new Date().toISOString() });
        return;
      } catch { /* unreadable details — heartbeat only */ }
    }
    this.runs.updateRun(runId, { updatedAt: new Date().toISOString() });
  }

  /** Bounded, non-fatal re-embed of written entries. The shared
   *  EmbeddingService has no deadline and accepts no cancel signal, so a hung
   *  provider call would otherwise sit until the 60-min stale sweep. Provider
   *  and missing-key failures record their own system_events inside the
   *  service; the one class it cannot see is OUR timeout (the call keeps
   *  running detached) — so every failure here surfaces as a warn event
   *  (the offscreen-merge site used to swallow it silently). Stale
   *  vectors backfill via the reembed tool. */
  private async reembed(run: { id: string; userId: string; campaignId: string }, entries: Array<{ id: string; userId: string; content: string }>, embedModelId: string, label: string): Promise<void> {
    await withTimeout(this.embedding.indexEntries(entries, embedModelId), WORKER_LLM_DEADLINE_MS, label)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn({ runId: run.id, count: entries.length, err }, `${label} failed/timed out — vectors stale until backfill`);
        recordSystemEvent({
          userId: run.userId, source: "campaign_audit", severity: "warn", campaignId: run.campaignId,
          message: `${label} failed for ${entries.length} entr${entries.length === 1 ? "y" : "ies"} — vectors stale until the reembed tool backfills them: ${message.slice(0, 160)}`,
          details: { runId: run.id, entryIds: entries.map((e) => e.id).slice(0, 50) },
        });
      });
  }
}

/** Readable substance of a coverage op for the findings queue: the
 *  basis plus a bounded slice of the proposed content, so a flagged coverage
 *  row shows the owner WHAT the audit wanted to write, not just an op verb. */
function coverageDetail(op: AuditOp): string | undefined {
  const parts: string[] = [];
  if (op.basis) parts.push(`basis: ${op.basis}`);
  if (op.content) parts.push(`proposed content: ${op.content.length > 600 ? op.content.slice(0, 600) + "…" : op.content}`);
  if (op.known_by && op.known_by.length > 0) parts.push(`known_by: ${op.known_by.join(", ")}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function parseEntryIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function validClaims(value: unknown): value is Array<{ entryIds: string[]; claim: string; detail?: string }> {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" &&
    typeof item.claim === "string" && item.claim.trim() && Array.isArray(item.entryIds) &&
    item.entryIds.every((id: unknown) => typeof id === "string") && (item.detail === undefined || typeof item.detail === "string"));
}
function validLedger(value: unknown): value is Array<{ entity: string; claims: Array<{ text: string; entryId: string }> }> {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" &&
    typeof item.entity === "string" && item.entity.trim() && Array.isArray(item.claims) && item.claims.every((claim: unknown) => {
      if (!claim || typeof claim !== "object") return false;
      const row = claim as { text?: unknown; entryId?: unknown };
      return typeof row.text === "string" && !!row.text.trim() && typeof row.entryId === "string" && !!row.entryId.trim();
    }));
}
function isAuditOperation(value: unknown): value is AuditOp {
  if (!value || typeof value !== "object") return false;
  const op = value as Partial<AuditOp>;
  if (op.op === "NOOP") return true;
  if (op.op === "CREATE") return typeof op.name === "string" && !!op.name.trim() && typeof op.content === "string" && !!op.content.trim();
  if (typeof op.entry_id !== "string" || !op.entry_id.trim()) return false;
  if (op.op === "UPDATE") return typeof op.content === "string" && !!op.content.trim();
  return op.op === "DISABLE" || op.op === "DELETE";
}
