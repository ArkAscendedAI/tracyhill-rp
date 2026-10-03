import { z } from "zod";

export const contextModeSchema = z.enum(["off", "keyword", "semantic", "hybrid"]);
export type ContextMode = z.infer<typeof contextModeSchema>;

/** The Engine panel's model-id dials. On EVERY one of them a blank string means
 *  INHERIT: the Android sheet
 *  sends `""` for "Inherit researcher model" on every save and the API stored
 *  it verbatim, so `hydeModel ?? researcherModel` handed HyDE the model `""` —
 *  a warn event and a narrowed retrieval on every hybrid turn. Two layers:
 *  the FULL schema reads a blank as absent (the dial's default applies), and
 *  the UPDATE schema keeps the key with an `undefined` value so the session's
 *  stored override is DELETED on merge (`{...stored, ...update}` then
 *  `JSON.stringify` drops it) and the dial falls back to its default — for
 *  hydeModel that is "inherit researcherModel at call time". antagonistModel
 *  and worldStateModel keep their documented blank meaning (off / use
 *  driveModel): their default IS `""`, so for them this is an identity.
 *  contextEngine.resolveSettings applies the same rule to rows written before
 *  the fix. A unit test pins that every *Model dial is listed here. */
export const CONTEXT_MODEL_ID_DIALS = [
  "embeddingModel", "researcherModel", "hydeModel", "rollingModel", "sceneValidatorModel",
  "driveModel", "worldTickModel", "dramatistModel", "repetitionModel", "syspromptAuditModel",
  "auditModel", "antagonistModel", "worldStateModel",
] as const;
export type ContextModelIdDial = (typeof CONTEXT_MODEL_ID_DIALS)[number];

/** The chat-model dials that take the deployment default model (`DEFAULT_MODEL_ID`)
 *  when one is configured. The engine's buildDefaults()
 *  and the web Engine panel read this list; each used to carry its own copy (the
 *  Android sheet still does, in `contextDefaultsJson`). The four model dials left
 *  out keep their shipped meaning under an override: embeddingModel names an
 *  embedding model, hydeModel inherits researcherModel at call time,
 *  antagonistModel's "" means off and worldStateModel's "" means "use driveModel".
 *  A unit test pins the partition, so a new model dial has to be placed. */
export const CONTEXT_DEFAULT_MODEL_DIALS = [
  "researcherModel", "rollingModel", "sceneValidatorModel", "driveModel", "worldTickModel",
  "dramatistModel", "repetitionModel", "syspromptAuditModel", "auditModel",
] as const satisfies readonly ContextModelIdDial[];
export type ContextDefaultModelDial = (typeof CONTEXT_DEFAULT_MODEL_DIALS)[number];

const blankIsInherit = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
/** A model-id dial: `""` (or whitespace) reads as absent before `schema` runs. */
const modelIdDial = <S extends z.ZodTypeAny>(schema: S) => z.preprocess(blankIsInherit, schema);

// The defaults are the values tuned on a long-running campaign, model choices excepted (and thinking/effort, which
// stay per model). Twelve changed on 2026-10-02: mode, the retrieval, context and history budgets, the Dramatist (on,
// standard, every 4th diff, ticks applied automatically), the scene validator's automatic regeneration (off), OpenAI
// fast mode (on), world stance 4 and depiction tier 3.
// Migration 0092 wrote the old values into every existing session that had none of its own, so no running session
// changed. A server's administrator sets the starting world stance and depiction tier for new sessions in
// Admin: Server settings → New sessions (servers that predate the change keep 1 and 0 there).
export const contextSettingsSchema = z.object({
  mode: contextModeSchema.default("hybrid"),
  // Ceiling raised 50k -> 200k (2026-07-31). The old 50,000 had no
  // basis: it entered in the V3 scaffolding commit d770ba9 (2026-05-01) against a
  // plan that specified a "token slider, 0–8000" with a default of 4,000, and was
  // never revisited while one campaign's lorebook grew to 822 entries / 325k tokens.
  // At that size a 32k budget covers ~10% of the lorebook per turn, and the model
  // starts inventing causes for conditions it can see in the transcript but cannot
  // explain from context.
  //
  // 200,000 is a QUALITY ceiling, not a wire limit. Long-context instruction
  // following degrades past roughly 200k, which matters more for prose than for
  // retrieval tasks. The wire limit is higher — a real rejection on the Anthropic
  // bridge path reads "prompt is too long: 1479102 tokens > 1000000 maximum" — so
  // acceptance is not the binding constraint; output quality is.
  //
  // BUDGET THIS AGAINST MEASURED TOTAL CONTEXT, NOT MODEL ctx. This dial is a
  // RESERVATION: windowConversation subtracts it from the transcript budget before
  // backfilling older turns, so raising it can silently shrink backfill wherever
  // backfill is still non-zero. It also stacks on top of the guaranteed transcript
  // tail, which is never trimmed — on a long campaign that tail alone can be half
  // the context. Measure input+cache_read+cache_write per turn before raising it.
  //
  // 16,000 is THE default (2026-09-02). It was two-valued for four months: this
  // schema said 4,000 while contextEngine.buildDefaults() resolved 16,000, so
  // the web Engine panel and Android displayed a quarter of the reservation the
  // server actually made. The Zod defaults are now the single source — see
  // CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS below, which the engine spreads.
  retrievalBudgetTokens: z.number().int().min(0).max(200000).default(42000),
  // Thread guarantee is a TOKEN cap, not a count (2026-09-25). An activated
  // thread entry is guaranteed at full size, but only while the promoted set
  // stays under this many estimator tokens; the rest compete for the budget
  // like everything else. The old cap was "8 entries"; on one long campaign the eight
  // largest thread entries summed to 47,675 tokens against a 42,000 budget, so
  // one crowded turn could starve every scored entry. 6,000 ≈ five or six
  // threads at the tracker's field caps (~1,100 tokens each).
  threadGuaranteeTokens: z.number().int().min(0).max(50000).default(6000),
  semanticTopK: z.number().int().min(1).max(50).default(20),
  semanticThreshold: z.number().min(0).max(1).default(0.25),
  // Effective minimum 1 (2026-09-02): the engine's global scan buffer was built
  // with `history.slice(-scanDepth * 2)`, and `slice(-0)` returns the WHOLE
  // history — so "0" (offered by the UI as "current turn only") silently scanned
  // every message in the session. 0 is still ACCEPTED on the wire (old saved
  // sessions and the shipped Android app can send it) but clamps to 1 here, and
  // contextEngine.resolveSettings clamps stored values the same way.
  scanDepth: z.number().int().min(0).max(100).default(4).transform((v) => Math.max(1, v)),
  contextBudgetTokens: z.number().int().min(0).max(2000000).default(120000),
  guaranteedMessageCount: z.number().int().min(2).max(200).default(70),
  // = DEFAULT_EMBEDDING_MODEL (model-catalog), which contracts cannot import;
  // a route test pins the two.
  embeddingModel: modelIdDial(z.string().default("google:gemini-embedding-2")),
  researcherEnabled: z.boolean().default(true),
  researcherModel: modelIdDial(z.string().default("claude-sonnet-4-6-bridge")),
  researcherMaxPicks: z.number().int().min(1).max(50).default(16),
  hydeEnabled: z.boolean().default(true),
  // Absent (or blank) = inherit researcherModel at call time.
  hydeModel: modelIdDial(z.string().optional()),
  // `rollingEnabled` and `rollingCadence` were removed 2026-09-29: nothing
  // outside the contract and the Engine dialog
  // ever read them, so the switch and the cadence changed nothing. Diffs enqueue
  // on pipelineAutoEnabled and rollingDiffCharThreshold, and "All workers" is how
  // to stop them. The web stopped reading them in f4b9ca57 and Android 1.1.8 stops
  // sending them; 1.1.7 still sends both, and unknown keys are stripped, so its
  // saves stay valid. Stored rows keep the dead keys; no reader looks at them.
  rollingModel: modelIdDial(z.string().default("claude-haiku-4-5-bridge")),
  sceneValidatorEnabled: z.boolean().default(true),
  sceneValidatorModel: modelIdDial(z.string().default("claude-haiku-4-5-bridge")),
  sceneValidatorAutoRegen: z.boolean().default(false),
  attireTrackingEnabled: z.boolean().default(true),
  attireStaleTurnThreshold: z.number().int().min(1).max(200).default(10),
  // Living World (NPC autonomy). npcAgendaEnabled renders the per-turn
  // <character_agendas> block for present characters that have drive sheets — a
  // no-op until a campaign is seeded. npcInitiative maps to system-prompt norms
  // (subtle/normal/assertive). driveModel runs the drive_update worker.
  npcAgendaEnabled: z.boolean().default(true),
  npcInitiative: z.enum(["subtle", "normal", "assertive"]).default("normal"),
  driveModel: modelIdDial(z.string().default("claude-sonnet-4-6-bridge")),
  // Phase 2 — world tick (manual offscreen simulation). autoApply skips review.
  worldTickModel: modelIdDial(z.string().default("claude-sonnet-4-6-bridge")),
  worldTickAutoApply: z.boolean().default(true),
  // Dramatist automation is opt-in for existing campaigns. Wizard approval
  // explicitly stamps true for new campaigns; a missing legacy key stays off.
  dramatistEnabled: z.boolean().default(true),
  dramatistModel: modelIdDial(z.string().default("claude-sonnet-4-6-bridge")),
  tickEveryNthRollingDiff: z.number().int().min(1).max(20).default(4),
  dramatistIntensity: z.enum(["restrained", "standard", "bold"]).default("standard"),
  // Reasoning effort for EVERY passive pipeline worker call (rolling diff,
  // tracker, drives, ticks/Dramatist, consolidation, archival, recap, audits,
  // rulings, sysprompt reviewer). "model-max" = the top rung of whichever
  // model each worker uses, the max-reasoning default. Applies to
  // effort-ladder providers (CodexBridge/OpenAI/xAI); Claude-bridge workers
  // are governed by their thinkingMode conventions and toggle-thinking
  // providers by their on/off toggle — see workerEffortFor in model-catalog.
  workerEffort: z.enum(["model-max", "xhigh", "high", "medium", "low"]).default("model-max"),
  pipelineAutoEnabled: z.boolean().default(true),
  rollingDiffCharThreshold: z.number().int().min(1000).max(200000).default(17000),
  repetitionCharThreshold: z.number().int().min(5000).max(500000).default(50000),
  repetitionModel: modelIdDial(z.string().default("claude-opus-4-6-bridge")),
  syspromptAuditCharThreshold: z.number().int().min(10000).max(1000000).default(100000),
  syspromptAuditModel: modelIdDial(z.string().default("claude-opus-4-6-bridge")),
  maxAntiRepetitionRules: z.number().int().min(10).max(300).default(80),
  antiRepArchiveAfter: z.number().int().min(2).max(20).default(5),
  // Campaign Audit (replaces campaign review). auditModel drives automated runs
  // and defaults the manual Quick/Full dialog. Auto QUICK on the frequent
  // entry-change cadence, auto FULL on a rare one.
  auditModel: modelIdDial(z.string().default("claude-opus-4-6-bridge")),
  auditAutoEnabled: z.boolean().default(true),
  auditQuickEveryNChanges: z.number().int().min(10).max(1000).default(50),
  auditFullEveryNChanges: z.number().int().min(50).max(5000).default(300),
  // `previewEnabled` (a dial with no reader) was removed 2026-09-02 once the
  // Android client stopped sending it; `response.context` streams on every
  // campaign turn regardless. Unknown keys from older clients are stripped.
  disabledEntryIds: z.array(z.string()).default([]),
  playerCharacterKeys: z.array(z.string()).default([]),
  // ── Grit contract ──────────────────────────────────────────────────────────
  // Two ORTHOGONAL dials. Conflating them loses control: an antagonist can decide
  // to do something terrible (stance) while the prose still fades to black
  // (depiction), and those are separate failures with separate fixes.
  //
  // Until 2026-10-02 both defaulted to the benign end (stance 1, tier 0) so the system shipped inert. Since then the
  // defaults are stance 4 and tier 3 (see the head of this schema): existing sessions were pinned to 1 and 0 (migration
  // 0092), and a server's administrator sets the starting values for new sessions in Admin: Server settings → New
  // sessions, which is where an administrator whose server has children on it turns them down. Both stay admin-only
  // dials per session.
  //
  // These govern PLAY ONLY. They never soften generation: the wizard always
  // produces a structurally capable substrate (real red lines, leverage,
  // concealment, antagonist schemes with an objective/method/target) regardless
  // of these values, because per-turn settings are reversible and a generated
  // corpus is not. Dialling a campaign up later must not require regenerating
  // its lorebook.
  //
  // worldStance — how causality resolves relative to <user>. Drives which floor
  // blocks inject, contested-outcome RNG weighting, and lethality authorisation.
  //   0 indulgent   resolves toward <user>
  //   1 earned      pressure is real, setbacks recoverable
  //   2 indifferent neutral; competence and position decide
  //   3 hostile     selects against <user> where motive and opportunity exist
  //   4 predatory   converges on the weakest point; loss is likely   [DEFAULT]
  worldStance: z.number().int().min(0).max(4).default(4),
  // depictionTier — how explicitly consequence is rendered. Tier N is a FLOOR
  // (do not render below it); the CEILING is the absence of tier N+1's block,
  // never a sentence telling the model to hold back. A prose ceiling is an
  // escape hatch on a positivity-biased model.
  //   0 none        no depiction block injected at all
  //   1 direct      plain and specific, no euphemism
  //   2 visceral    injury/violence/aftermath in sensory detail
  //   3 unflinching extreme material at the intensity causality produces [DEFAULT]
  depictionTier: z.number().int().min(0).max(3).default(3),
  // Antagonist-intent routing. Villain fidelity is a measured model disposition
  // (arXiv 2511.04962: Claude near the bottom, GLM/DeepSeek/Kimi top), so
  // antagonist DECISIONS are authored off-Claude and the prose model only renders
  // them. Empty string = disabled (render model decides, the old behaviour).
  antagonistModel: modelIdDial(z.string().default("")),
  // Storyteller pacing (RimWorld's insight: the same event pool feels completely
  // different under different pacing algorithms, and letting the owner pick the
  // curve is more useful than tuning one "correct" rhythm). Modulates how fast
  // offscreen clocks advance per tick.
  //   steady   one segment per tick — predictable escalation      [DEFAULT]
  //   relaxed  a segment every other tick — long quiet stretches
  //   chaotic  0-3 segments, decoupled from the cycle
  storytellerPacing: z.enum(["steady", "relaxed", "chaotic"]).default("steady"),
  // ─── Phase 7 producers ─────────────────────────────────────────────────────
  // Phases 3-6 shipped with every CONSUMER wired and no producer, so the state
  // tables could only ever be empty: threats were burned but never armed,
  // consequences read but never written, clocks advanced but never created. These
  // dials own the writers. All THREE are gated on worldStance >= 2 in code, so
  // they stay inert at the shipped default exactly like the rest of the system —
  // defaulting them ON is what makes them real the moment the owner dials up,
  // instead of being one more thing that silently does nothing.
  //
  // Reads the finished turn and writes threats, consequences and grudges. Deaths
  // pass an adversarial refute gate first; nothing here ever raises trust,
  // because a positivity-biased reader over-detects warmth and that is the exact
  // failure this system exists to remove.
  worldStateExtractionEnabled: z.boolean().default(true),
  // Empty string falls back to driveModel — one fewer thing to configure, and the
  // drive model is already the small-worker slot for this campaign.
  worldStateModel: modelIdDial(z.string().default("")),
  // Classifies the player's turn BEFORE rendering so a contested action is
  // resolved by CSPRNG and injected as a settled result. Models are documented
  // fudging rolls and retconning defeats, so the model must never hold the dice.
  contestedOutcomesEnabled: z.boolean().default(true),
  coldInflationWeightMultiplier: z.number().min(0).max(2).default(0.6),
  // Anthropic DIRECT fast mode (research preview). When true AND the composer
  // model is a direct Anthropic model with catalog fast pricing, chatService
  // passes speed:"fast" to the runtime. Claude bridge variants stay excluded
  // (2026-09-09): the Agent SDK can take fastMode as a session
  // setting, but it bills usage credits at the direct fast rate and only exists
  // on Opus 4.8/5. OpenAI models are governed by openaiFastModeEnabled below.
  // Default OFF on every new session per project policy.
  fastModeEnabled: z.boolean().default(false),
  // OpenAI fast mode (2026-09-09). ONE switch for every OpenAI channel: the composer, the per-turn
  // helpers (HyDE, researcher, scene validator, presence, world-state,
  // antagonist intent, contested action) and every pipeline worker, whenever the
  // call's resolved model is an OpenAI model that supports it — direct entries
  // with catalog fast pricing (service_tier:"fast", 2× applicable rates) and
  // CodexBridge entries whose App Server advertises a fast service tier
  // (`priority`; $0 marginal, faster subscription-usage burn). Resolution is
  // openaiFastModeFor() in model-catalog; unsupported models run standard and
  // every message/run records what the provider actually applied. The wizard
  // is outside this dial (it runs before any session exists). Default ON since 2026-10-02 (head of this schema);
  // sessions that predate it were pinned to their old value.
  openaiFastModeEnabled: z.boolean().default(true),
  // ── Character Engine (2026-08-30, mined from the Realistic Frankenstein 2.0 preset) ──────────────
  // Unlike the grit dials these default ON. They target two problems: bland interchangeable character
  // voices and AI-slop prose.
  //
  // characterIntegrityEnabled injects the voice pack (locked idiolects, human
  // register, taste independence, structural anti-slop, lexicon bans) as a
  // system-prompt section AND a terse <style_gate> at the recency end of the
  // injected blocks. Pure craft: it changes no world outcome and no content
  // scope (stance/tier own that).
  characterIntegrityEnabled: z.boolean().default(true),
  // sceneTempoEnabled rolls a per-turn pacing gear (NEUTRAL 40 / STEADY 40 /
  // DRIVE 20, hysteresis-folded) hashed from the triggering user message id —
  // contested-outcome seed discipline, so regenerates re-render the same gear.
  // NEUTRAL legitimizes the quiet turn; settled work (contests, beats,
  // antagonist decisions) floors it to STEADY in code.
  sceneTempoEnabled: z.boolean().default(true),
  // ── Content Honesty / decensor stack (2026-08-30, same Realistic Frankenstein source preset) ──────
  // The refusal-prevention layer for the models that need it: consent/scope
  // system section + a synthetic first-person assistant consent turn (the
  // mechanism is the ROLE — system-text-only scored 0/8 in the battery) + a
  // recency-end scope reminder. Default ON like the other 2026-08-30 additions,
  // but structurally GATED (contentHonestyApplies): fires only on Google and
  // Kimi-K3 composers — Anthropic sessions never see it. Validated at 95%
  // pooled (38/40) on the battery's hardest classes.
  contentHonestyEnabled: z.boolean().default(true),
});
export type ContextSettings = z.infer<typeof contextSettingsSchema>;

/** The adversarial-world dials only a workspace admin may change (the grit
 *  contract). The API drops a non-admin's
 *  value that equals the session's effective value and refuses a changed one
 *  with 403, saving nothing; the web renders these rows read-only for
 *  non-admins; Android 1.1.7 strips them from a non-admin's save
 *  (`OWNER_CONTEXT_FIELDS`, the same seven). */
export const CONTEXT_ADMIN_ONLY_DIALS = [
  "worldStance", "depictionTier", "antagonistModel", "storytellerPacing",
  "worldStateExtractionEnabled", "worldStateModel", "contestedOutcomesEnabled",
] as const satisfies readonly (keyof ContextSettings)[];
export type ContextAdminOnlyDial = (typeof CONTEXT_ADMIN_ONLY_DIALS)[number];

// The EFFECTIVE per-session defaults — what a session with no override actually
// runs at. Single-sourced from the Zod `.default()` values above (2026-09-02):
// contextEngine.buildDefaults() spreads this object (layering only the
// DEFAULT_MODEL_ID deployment override on the chat-model dials), and the web
// Engine panel / Android settings sheet should read their display defaults from
// here instead of carrying literal copies. Frozen: consumers must spread, never
// mutate (the two array dials are shared references).
export const CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS: Readonly<ContextSettings> = Object.freeze(contextSettingsSchema.parse({}));

// disabledEntryIds is intentionally writable: the engine has always
// honored it (contextEngine builds its disabled set from it) but this schema
// used to .omit() it, leaving per-session entry-disable unreachable via the API.
//
// Model-id dials on the UPDATE path map a blank to `undefined` WITHOUT the
// dial's default: the key survives parsing with an undefined value, the
// workspace merge spreads it over the stored override and JSON.stringify drops
// it — the override is cleared and the dial inherits again. Through
// `.partial()` alone a blank would have pinned the shipped default instead.
const inheritOnUpdate = z.preprocess(blankIsInherit, z.string().optional());
const updateModelDials = Object.fromEntries(CONTEXT_MODEL_ID_DIALS.map((dial) => [dial, inheritOnUpdate])) as Record<ContextModelIdDial, typeof inheritOnUpdate>;
export const contextSettingsUpdateSchema = contextSettingsSchema.partial().extend(updateModelDials);
export type ContextSettingsUpdate = z.infer<typeof contextSettingsUpdateSchema>;

export const contextPreviewEntrySchema = z.object({
  entryId: z.string(),
  name: z.string(),
  tag: z.string().nullable(),
  // Every value the engine can emit. "cold-keyword" (a disabled cold entry's
  // keys triggering its compressed parent) was missing until 2026-09-02, and
  // the web's safeParse dropped the ENTIRE response.context event for any turn
  // that carried one — the Preview went blank exactly when cold storage was
  // doing work. A unit test pins the engine's source values to this enum.
  source: z.enum(["constant", "sticky", "keyword", "cold-keyword", "semantic", "researcher", "scene-present", "cold-inflate"]),
  score: z.number(),
  tokenCost: z.number().int(),
  included: z.boolean(),
});
export type ContextPreviewEntry = z.infer<typeof contextPreviewEntrySchema>;

export const contextAssemblyDebugSchema = z.object({
  keywordHits: z.number().int(),
  semanticHits: z.number().int(),
  researcherHits: z.number().int(),
  absentContacts: z.number().int().default(0),
  coldInflations: z.number().int(),
  droppedForBudget: z.number().int(),
  totalTokens: z.number().int(),
});
export type ContextAssemblyDebug = z.infer<typeof contextAssemblyDebugSchema>;

export const contextPreviewResponseSchema = z.object({
  entries: z.array(contextPreviewEntrySchema),
  totalTokens: z.number().int(),
  budgetTokens: z.number().int(),
  debug: contextAssemblyDebugSchema,
  notes: z.array(z.string()).default([]),
});
export type ContextPreviewResponse = z.infer<typeof contextPreviewResponseSchema>;

export const contextPreviewRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(50000),
  // When true (default), assembly runs fully side-effect-free: no sticky/cooldown
  // /activation-state writes, no lastActivatedTurn persistence — preview a
  // hypothetical user message without burning a turn or mutating session state.
  dryRun: z.boolean().default(true),
  // `false` skips every network phase of the
  // assembly (HyDE, the query embedding, the researcher) so a measurement costs
  // no paid call; keyword and scene-present retrieval still run. Absent means
  // true, the behavior before the option existed.
  network: z.boolean().optional(),
});
export type ContextPreviewRequest = z.infer<typeof contextPreviewRequestSchema>;

export const characterAttireRecordSchema = z.object({
  campaignId: z.string(),
  characterName: z.string(),
  attireDescription: z.string(),
  lastUpdatedTurn: z.number().int(),
  lastUpdatedMessageId: z.string().nullable(),
  lastSeenInPresentTurn: z.number().int(),
  source: z.string(),
  updatedAt: z.string(),
});
export type CharacterAttireRecord = z.infer<typeof characterAttireRecordSchema>;

export const characterAttireListResponseSchema = z.object({
  entries: z.array(characterAttireRecordSchema),
});
export type CharacterAttireListResponse = z.infer<typeof characterAttireListResponseSchema>;

export const updateCharacterAttireRequestSchema = z.object({
  attireDescription: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(240).optional(),
  // Turn to stamp a manual edit at (the composer knows its loaded tail);
  // the server resolves the campaign's current turn when absent.
  turn: z.number().int().min(0).optional(),
});
export type UpdateCharacterAttireRequest = z.infer<typeof updateCharacterAttireRequestSchema>;

export const embeddingRebuildRequestSchema = z.object({
  campaignId: z.string(),
  // = DEFAULT_EMBEDDING_MODEL, pinned by the same test as embeddingModel.
  model: z.string().default("google:gemini-embedding-2"),
  staleOnly: z.boolean().default(false),
});
export type EmbeddingRebuildRequest = z.infer<typeof embeddingRebuildRequestSchema>;

/** Response of `/api/context/embeddings/rebuild`. */
export const embeddingRebuildResponseSchema = z.object({ indexed: z.number().int(), total: z.number().int() });
export type EmbeddingRebuildResponse = z.infer<typeof embeddingRebuildResponseSchema>;

// ─── Prompt fragments (2026-09-24) ────────────────────────────────────────────
// What the engine injects around the campaign prompt for a session, in wire
// order — the Engine dialog's "Injected text" viewer. System texts ship with the
// app (read-only); campaign/lorebook/drive content is edited in its own panel.
export const promptFragmentSchema = z.object({
  id: z.string(),
  /** Engine-dialog row ids this fragment belongs to (a row shows a "view text" button when non-empty). */
  settings: z.array(z.string()),
  group: z.string(),
  title: z.string(),
  level: z.enum(["system", "campaign", "dynamic"]),
  placement: z.string(),
  /** Whether the fragment is injected for this session's current settings and composer. */
  active: z.boolean(),
  note: z.string().nullable(),
  /** The exact text, or null for content composed per turn. */
  text: z.string().nullable(),
  /** Where the text comes from — shipped with the app, written at campaign creation, a worker, campaign state. */
  origin: z.string(),
  /** How (or whether) the user can change it, and which dial or panel does it. */
  editing: z.string(),
  editIn: z.enum(["drives", "lorebook", "campaign"]).nullable(),
});
export type PromptFragment = z.infer<typeof promptFragmentSchema>;
export const promptFragmentsResponseSchema = z.object({ fragments: z.array(promptFragmentSchema) });
export type PromptFragmentsResponse = z.infer<typeof promptFragmentsResponseSchema>;
