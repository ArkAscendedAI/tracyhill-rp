import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { CONTEXT_ADMIN_ONLY_DIALS, type ContextSettings, type PromptFragment, type ProviderKeyListResponse } from "@tracyhill-rp/contracts";
import { EMBEDDING_MODELS, openaiFastModeSupportedModels } from "@tracyhill-rp/model-catalog";

import { getSavedChatModel, type AvailableChatModel } from "../auth/providerKeyApi";
import { Dialog } from "../../shared/ui/Dialog";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/iconSprite";
import { NumericInput } from "../../shared/ui/NumericInput";
import { ModelDialOptions } from "./modelDialOptions";
import { fetchPromptFragments } from "./promptFragmentsApi";

/**
 * The Context Engine settings (2026-09-24: the same dials as the 460 px popover this
 * replaced, none added, removed or re-meaning). Five pages, one row per dial: a plain-words label, its explanation visible, the
 * control on the right; switches for booleans. The rows are a table (`ROWS`) so the search box
 * can look across every page and jump to the row. Every `aria-label` is the one the popover
 * used, every save is the same `contextOverrides` write, and every show/hide rule is preserved
 * (`when`); a hidden row still turns up in search, with the rule that reveals it.
 * Since then: the Rolling diff switch and its Cadence row were removed (2026-09-29:
 * nothing read either one; "Automatic workers" is the way to stop the diff), and the
 * seven adversarial-world rows are read-only for non-admins.
 */
type Page = "context" | "scene" | "world" | "workers" | "audit";

const PAGES: Array<{ id: Page; label: string; icon: IconName; blurb: string }> = [
  { id: "context", label: "Context", icon: "book-open", blurb: "What the composer sees each turn: how lorebook entries are chosen, how much transcript and lore fit, and the two helpers that widen recall." },
  { id: "scene", label: "Scene & craft", icon: "eye", blurb: "Per-turn checks on each reply (presence, attire) and the craft layer that governs voice, pacing and refusal-prevention." },
  { id: "world", label: "World", icon: "globe", blurb: "Agendas inject present NPC wants. World tick simulates offscreen activity on demand. The Dramatist periodically arms grounded complications from live campaign state." },
  { id: "workers", label: "Workers", icon: "wrench", blurb: "The background writers that keep canon: when they run, how hard they think, and which model each uses." },
  { id: "audit", label: "Audit", icon: "scale", blurb: "Reconciles the lorebook against the full story — no watermarks. Run it by hand from Campaign Audit next to the campaign chip." },
];
const pageLabel = (id: Page) => PAGES.find((p) => p.id === id)!.label;

type Ctx = {
  s: ContextSettings;
  disabled: boolean;
  set: (patch: Record<string, unknown>) => void;
  models: ReadonlyArray<AvailableChatModel>;
  config: ProviderKeyListResponse | undefined;
  hasCampaign: boolean;
  onAdvanceWorld: () => void;
  /** Injected-text fragments for a row id (empty when none) and the viewer opener. */
  fragmentsFor: (rowId: string) => PromptFragment[];
  openText: (rowId: string | null) => void;
  /** The signed-in user's role is admin (the shell's `user.role`); gates the admin-only rows. */
  isAdmin: boolean;
};

type RowDef = {
  id: string;
  page: Page;
  group: string;
  label: string;
  hint?: string;
  /** Extra search terms (the old one-word labels, synonyms). The aria-label is always searched. */
  keywords?: string;
  aria: string;
  /** Show/hide rule — identical to the popover's. */
  when?: (ctx: Ctx) => boolean;
  /** Plain-words statement of `when`, shown in search results for a hidden row. */
  requires?: string;
  /** The row to flash when a hidden row is navigated to (its parent toggle). */
  parent?: string;
  control: (ctx: Ctx) => ReactNode;
};

/**
 * Rows the server keeps for admins: the contract's CONTEXT_ADMIN_ONLY_DIALS, which the API's
 * gate reads too (a row's id is its settings field). For anyone else the row shows the effective
 * value with its control disabled and says who sets it: the
 * control used to look editable and snap back.
 */
const ADMIN_ONLY_DIALS: ReadonlySet<string> = new Set(CONTEXT_ADMIN_ONLY_DIALS);
const isAdminOnlyRow = (row: RowDef) => ADMIN_ONLY_DIALS.has(row.id);

const FAST_MODE_HINT = (() => {
  const supported = openaiFastModeSupportedModels();
  const direct = supported.filter((m) => m.provider === "openai").map((m) => m.label).join(", ") || "none";
  const bridge = supported.filter((m) => m.provider === "codex-bridge").map((m) => m.label.replace(" (CodexBridge)", "")).join(", ") || "none";
  return `One switch for every OpenAI channel — the composer, the per-turn helpers and every worker — whenever that call's model supports it. Direct (2× rates): ${direct}. Codex bridge (no extra charge, faster subscription burn): ${bridge}.`;
})();

/* ── controls (module level so a re-render never remounts a focused field) ─────────────── */
function Switch({ ctx, field, aria }: { ctx: Ctx; field: keyof ContextSettings; aria: string }) {
  const checked = Boolean(ctx.s[field]);
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={aria} className={`eng-switch${checked ? " is-on" : ""}`} onClick={() => ctx.set({ [field]: !checked })} disabled={ctx.disabled}>
      <span className="eng-switch-knob" aria-hidden="true" />
      <span className="eng-switch-text" aria-hidden="true">{checked ? "On" : "Off"}</span>
    </button>
  );
}
function Num({ ctx, field, aria, min, max, step, width = 64, unit }: { ctx: Ctx; field: keyof ContextSettings; aria: string; min: number; max: number; step?: number; width?: number; unit?: string }) {
  return (
    <>
      <NumericInput aria-label={aria} min={min} max={max} step={step} value={ctx.s[field] as number} disabled={ctx.disabled} onChange={(v) => ctx.set({ [field]: v })} style={{ width }} />
      {unit ? <span className="eng-unit">{unit}</span> : null}
    </>
  );
}
function ModelSelect({ ctx, field, aria, value, emptyOption }: { ctx: Ctx; field: keyof ContextSettings; aria: string; value?: string; emptyOption?: string }) {
  const current = value ?? (ctx.s[field] as string);
  return (
    <select aria-label={aria} value={current} disabled={ctx.disabled} onChange={(event) => ctx.set({ [field]: event.target.value })}>
      {emptyOption !== undefined ? <option value="">{emptyOption}</option> : null}
      <ModelDialOptions models={ctx.models} value={current} config={ctx.config} />
    </select>
  );
}
function Choice({ ctx, field, aria, options, numeric }: { ctx: Ctx; field: keyof ContextSettings; aria: string; options: Array<[string | number, string]>; numeric?: boolean }) {
  return (
    <select aria-label={aria} value={ctx.s[field] as string | number} disabled={ctx.disabled} onChange={(event) => ctx.set({ [field]: numeric ? Number(event.target.value) : event.target.value })}>
      {options.map(([value, label]) => <option key={String(value)} value={value}>{label}</option>)}
    </select>
  );
}

const semantic = (ctx: Ctx) => ctx.s.mode === "semantic" || ctx.s.mode === "hybrid";
/** A model id's label: the keyed picker list first (custom endpoints live there), then the saved-model lookup, then the id. */
const modelLabel = (ctx: Ctx, id: string) => ctx.models.find((m) => m.id === id)?.label ?? getSavedChatModel(id, ctx.config)?.label ?? id;

/* ── the dials — page order, group order, row order ────────────────────────────────────── */
const ROWS: RowDef[] = [
  // Context · Retrieval
  { id: "mode", page: "context", group: "Retrieval", label: "Retrieval mode", hint: "How lorebook entries are chosen each turn: trigger keywords, embedding similarity, both, or none.", keywords: "keyword semantic hybrid off", aria: "Context mode",
    control: (ctx) => <Choice ctx={ctx} field="mode" aria="Context mode" options={[["keyword", "Keyword"], ["semantic", "Semantic"], ["hybrid", "Hybrid"], ["off", "Off"]]} /> },
  { id: "embeddingModel", page: "context", group: "Retrieval", label: "Embedding model", hint: "Switching re-embeds the whole campaign (cold entries included) in the background; retrieval is keyword-only until it finishes.", aria: "Embedding model", when: semantic, requires: "Retrieval mode is Semantic or Hybrid", parent: "mode",
    control: (ctx) => (
      <select aria-label="Embedding model" value={ctx.s.embeddingModel} disabled={ctx.disabled} onChange={(event) => ctx.set({ embeddingModel: event.target.value })}>
        {EMBEDDING_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    ) },
  { id: "semanticTopK", page: "context", group: "Retrieval", label: "Semantic matches", hint: "The most similar entries considered per turn.", keywords: "top-k topk", aria: "Semantic Top-K", when: semantic, requires: "Retrieval mode is Semantic or Hybrid", parent: "mode",
    control: (ctx) => <Num ctx={ctx} field="semanticTopK" aria="Semantic Top-K" min={1} max={50} width={56} /> },
  { id: "semanticThreshold", page: "context", group: "Retrieval", label: "Similarity threshold", hint: "Minimum cosine similarity for a semantic match, 0 to 1.", aria: "Semantic threshold", when: semantic, requires: "Retrieval mode is Semantic or Hybrid", parent: "mode",
    control: (ctx) => <Num ctx={ctx} field="semanticThreshold" aria="Semantic threshold" min={0} max={1} step={0.05} width={64} /> },
  { id: "scanDepth", page: "context", group: "Retrieval", label: "Scan depth", hint: "Recent turns scanned for trigger keywords.", keywords: "scan turns", aria: "Scan depth",
    control: (ctx) => <Num ctx={ctx} field="scanDepth" aria="Scan depth" min={1} max={100} width={56} unit="turns" /> },
  { id: "retrievalBudgetTokens", page: "context", group: "Retrieval", label: "Retrieval budget", hint: "Tokens of lorebook context delivered per turn; guaranteed entries are not counted.", keywords: "budget tok tokens lorebook", aria: "Retrieval budget tokens",
    control: (ctx) => <Num ctx={ctx} field="retrievalBudgetTokens" aria="Retrieval budget tokens" min={0} max={200000} step={500} width={84} unit="tokens" /> },
  { id: "threadGuaranteeTokens", page: "context", group: "Retrieval", label: "Thread guarantee", hint: "Tokens of activated thread entries guaranteed at full size each turn; the rest compete for the retrieval budget. Keeps crowded turns from starving the scored entries.", keywords: "threads guarantee tok tokens tracker", aria: "Thread guarantee tokens",
    control: (ctx) => <Num ctx={ctx} field="threadGuaranteeTokens" aria="Thread guarantee tokens" min={0} max={50000} step={500} width={84} unit="tokens" /> },
  { id: "contextBudgetTokens", page: "context", group: "Retrieval", label: "Transcript budget", hint: "Upper bound on the transcript the composer receives (120,000 by default).", keywords: "context tok tokens window", aria: "Context budget tokens",
    control: (ctx) => <Num ctx={ctx} field="contextBudgetTokens" aria="Context budget tokens" min={10000} max={2000000} step={10000} width={96} unit="tokens" /> },
  { id: "guaranteedMessageCount", page: "context", group: "Retrieval", label: "Guaranteed recent messages", hint: "Always kept in the transcript, whatever the budget.", keywords: "guaranteed msgs", aria: "Guaranteed message count",
    control: (ctx) => <Num ctx={ctx} field="guaranteedMessageCount" aria="Guaranteed message count" min={2} max={200} width={56} unit="msgs" /> },
  { id: "coldInflationWeightMultiplier", page: "context", group: "Retrieval", label: "Cold entry weight", hint: "Score multiplier when an archived entry inflates back to full content: 1 = equal to active entries, below 1 = down-weighted, 0 = only if budget is left over.", keywords: "cold weight archive inflation multiplier", aria: "Cold inflation weight multiplier",
    control: (ctx) => <Num ctx={ctx} field="coldInflationWeightMultiplier" aria="Cold inflation weight multiplier" min={0} max={2} step={0.1} width={56} unit="×" /> },
  // Context · Recall helpers
  { id: "hydeEnabled", page: "context", group: "Recall helpers", label: "Query expansion (HyDE)", hint: "A small model rewrites your turn into a hypothetical answer to widen semantic recall.", keywords: "hyde", aria: "HyDE enabled",
    control: (ctx) => <Switch ctx={ctx} field="hydeEnabled" aria="HyDE enabled" /> },
  // A blank dial inherits the researcher model at call time. The inherit entry names that
  // model; choosing it saves "" and the update schema clears the override (the select had no
  // way back to inheriting once a model was picked, and showed a pinned researcher like an inherit).
  { id: "hydeModel", page: "context", group: "Recall helpers", label: "HyDE model", hint: "Inherit uses the researcher model and follows it when that changes.", aria: "HyDE model", when: (ctx) => ctx.s.hydeEnabled, requires: "Query expansion is on", parent: "hydeEnabled",
    control: (ctx) => <ModelSelect ctx={ctx} field="hydeModel" aria="HyDE model" value={ctx.s.hydeModel?.trim() ? ctx.s.hydeModel : ""} emptyOption={`Inherit researcher model (${modelLabel(ctx, ctx.s.researcherModel)})`} /> },
  { id: "researcherEnabled", page: "context", group: "Recall helpers", label: "Researcher", hint: "A small model picks the entries the keyword and semantic passes missed.", aria: "Researcher enabled",
    control: (ctx) => <Switch ctx={ctx} field="researcherEnabled" aria="Researcher enabled" /> },
  { id: "researcherModel", page: "context", group: "Recall helpers", label: "Researcher model", aria: "Researcher model", when: (ctx) => ctx.s.researcherEnabled, requires: "Researcher is on", parent: "researcherEnabled",
    control: (ctx) => <ModelSelect ctx={ctx} field="researcherModel" aria="Researcher model" /> },
  { id: "researcherMaxPicks", page: "context", group: "Recall helpers", label: "Researcher max picks", hint: "Entries the researcher may add per turn.", aria: "Researcher max picks", when: (ctx) => ctx.s.researcherEnabled, requires: "Researcher is on", parent: "researcherEnabled",
    control: (ctx) => <Num ctx={ctx} field="researcherMaxPicks" aria="Researcher max picks" min={1} max={50} width={56} /> },

  // Scene & craft · Scene validator
  { id: "sceneValidatorEnabled", page: "scene", group: "Scene validator", label: "Scene validator", hint: "A small model checks each reply for presence drift and offers a three-way resolution.", keywords: "presence verifier", aria: "Scene validator enabled",
    control: (ctx) => <Switch ctx={ctx} field="sceneValidatorEnabled" aria="Scene validator enabled" /> },
  { id: "sceneValidatorModel", page: "scene", group: "Scene validator", label: "Validator model", aria: "Scene validator model", when: (ctx) => ctx.s.sceneValidatorEnabled, requires: "Scene validator is on", parent: "sceneValidatorEnabled",
    control: (ctx) => <ModelSelect ctx={ctx} field="sceneValidatorModel" aria="Scene validator model" /> },
  { id: "sceneValidatorAutoRegen", page: "scene", group: "Scene validator", label: "Regenerate on resolution", hint: "Regenerate the newest reply when you accept the validator's or your own correction.", keywords: "auto-regen regen", aria: "Scene validator auto-regen", when: (ctx) => ctx.s.sceneValidatorEnabled, requires: "Scene validator is on", parent: "sceneValidatorEnabled",
    control: (ctx) => <Switch ctx={ctx} field="sceneValidatorAutoRegen" aria="Scene validator auto-regen" /> },
  // The attire rows follow the chat service's gate, Attire tracking alone (turnBlocks.ts): with the
  // validator off the stored attire still injects and ages, so both rows stay reachable.
  { id: "attireTrackingEnabled", page: "scene", group: "Scene validator", label: "Attire tracking", hint: "Injects each present character's recorded attire. The scene validator updates it after every reply; with the validator off, the stored attire still injects and ages.", keywords: "clothes outfit", aria: "Attire tracking enabled",
    control: (ctx) => <Switch ctx={ctx} field="attireTrackingEnabled" aria="Attire tracking enabled" /> },
  { id: "attireStaleTurnThreshold", page: "scene", group: "Scene validator", label: "Attire stale after", hint: "Turns since a character was last seen before their recorded attire is flagged stale.", aria: "Attire stale-after turns", when: (ctx) => ctx.s.attireTrackingEnabled, requires: "Attire tracking is on", parent: "attireTrackingEnabled",
    control: (ctx) => <Num ctx={ctx} field="attireStaleTurnThreshold" aria="Attire stale-after turns" min={1} max={200} step={1} width={56} unit="turns" /> },
  // Scene & craft · Character engine
  { id: "characterIntegrityEnabled", page: "scene", group: "Character engine", label: "Character voice pack", hint: "Injects the voice pack (locked idiolects, human register, plain speech, anti-slop lexicon) plus a short style gate at the end of the prompt.", keywords: "integrity idiolect slop", aria: "Character voice pack",
    control: (ctx) => <Switch ctx={ctx} field="characterIntegrityEnabled" aria="Character voice pack" /> },
  { id: "sceneTempoEnabled", page: "scene", group: "Character engine", label: "Scene tempo", hint: "Server-rolled pacing gear per turn (neutral 40% / steady 40% / drive 20%, anti-streak) so a quiet, plotless turn is a legitimate reply; seeded per message, so regenerates keep the gear. Shown in Preview.", keywords: "pacing gear", aria: "Scene tempo",
    control: (ctx) => <Switch ctx={ctx} field="sceneTempoEnabled" aria="Scene tempo" /> },
  { id: "contentHonestyEnabled", page: "scene", group: "Character engine", label: "Content honesty", hint: "Refusal-prevention stack: a consent/scope section, a synthetic assistant consent turn and a scope reminder every turn. Fires only on Google and Kimi composers; Anthropic sessions never see it.", keywords: "refusal consent", aria: "Content honesty",
    control: (ctx) => <Switch ctx={ctx} field="contentHonestyEnabled" aria="Content honesty" /> },

  // World · Living world
  { id: "npcAgendaEnabled", page: "world", group: "Living world", label: "NPC agendas", hint: "Injects present NPCs' wants and pressures into the prompt.", keywords: "agendas wants", aria: "NPC agendas",
    control: (ctx) => <Switch ctx={ctx} field="npcAgendaEnabled" aria="NPC agendas" /> },
  { id: "npcInitiative", page: "world", group: "Living world", label: "NPC initiative", hint: "How readily NPCs act on their wants without being prompted.", keywords: "subtle normal assertive", aria: "NPC initiative",
    control: (ctx) => <Choice ctx={ctx} field="npcInitiative" aria="NPC initiative" options={[["subtle", "Subtle"], ["normal", "Normal"], ["assertive", "Assertive"]]} /> },
  { id: "playerCharacterKeys", page: "world", group: "Living world", label: "Player character names", hint: "Comma-separated. Excluded from drive sheets, agenda injection and the Dramatist's inventory; de-prioritized in keyword retrieval.", keywords: "pc player character", aria: "Player character names",
    control: (ctx) => (
      <input
        type="text"
        aria-label="Player character names"
        placeholder="e.g. Jane Doe, Alias"
        className="eng-text"
        defaultValue={(ctx.s.playerCharacterKeys ?? []).join(", ")}
        disabled={ctx.disabled}
        onBlur={(event) => {
          const next = event.target.value.split(",").map((v) => v.trim()).filter(Boolean);
          const current = ctx.s.playerCharacterKeys ?? [];
          if (JSON.stringify(next) !== JSON.stringify(current)) ctx.set({ playerCharacterKeys: next });
        }}
      />
    ) },
  // World · Adversarial world
  { id: "worldStance", page: "world", group: "Adversarial world", label: "World stance", hint: "How causality resolves relative to you. Gates which floor rules inject, contested-roll weighting and lethality.", keywords: "indulgent earned indifferent hostile predatory stance", aria: "World stance",
    control: (ctx) => <Choice ctx={ctx} field="worldStance" aria="World stance" numeric options={[[0, "0 · Indulgent"], [1, "1 · Earned"], [2, "2 · Indifferent"], [3, "3 · Hostile"], [4, "4 · Predatory"]]} /> },
  { id: "depictionTier", page: "world", group: "Adversarial world", label: "Depiction tier", hint: "How explicitly consequence is rendered. Tier N is a floor; the ceiling is that tier N+1 is never injected.", keywords: "direct visceral unflinching depiction", aria: "Depiction tier",
    control: (ctx) => <Choice ctx={ctx} field="depictionTier" aria="Depiction tier" numeric options={[[0, "0 · None"], [1, "1 · Direct"], [2, "2 · Visceral"], [3, "3 · Unflinching"]]} /> },
  { id: "antagonistModel", page: "world", group: "Adversarial world", label: "Antagonist model", hint: "Authors antagonist decisions, not prose. Off lets the render model decide.", keywords: "antagonist intent", aria: "Antagonist intent model",
    control: (ctx) => <ModelSelect ctx={ctx} field="antagonistModel" aria="Antagonist intent model" emptyOption="Off (render model decides)" /> },
  { id: "storytellerPacing", page: "world", group: "Adversarial world", label: "Threat pacing", hint: "How fast offscreen threat clocks advance per world tick. Inert below stance 2.", keywords: "storyteller pacing steady relaxed chaotic clocks", aria: "Storyteller pacing",
    control: (ctx) => <Choice ctx={ctx} field="storytellerPacing" aria="Storyteller pacing" options={[["steady", "Steady"], ["relaxed", "Relaxed"], ["chaotic", "Chaotic"]]} /> },
  { id: "worldStateExtractionEnabled", page: "world", group: "Adversarial world", label: "Record world state", hint: "Reads each finished turn and records threats, deaths, maimings and grudges as campaign state; deaths pass an adversarial check first. No effect below stance 2.", keywords: "extraction deaths grudges", aria: "Record world state",
    control: (ctx) => <Switch ctx={ctx} field="worldStateExtractionEnabled" aria="Record world state" /> },
  { id: "contestedOutcomesEnabled", page: "world", group: "Adversarial world", label: "Contested outcomes", hint: "Classifies your turn before it renders and resolves contests with server-side dice, so the model is told the outcome instead of choosing it.", keywords: "dice contests rolls", aria: "Contested outcomes",
    control: (ctx) => <Switch ctx={ctx} field="contestedOutcomesEnabled" aria="Contested outcomes" /> },
  { id: "worldStateModel", page: "world", group: "Adversarial world", label: "World-state model", hint: "For world-state extraction and contest classification. Blank uses the drive-sheet model.", aria: "World state model",
    control: (ctx) => <ModelSelect ctx={ctx} field="worldStateModel" aria="World state model" emptyOption="(use drive-sheet model)" /> },
  // World · Offscreen simulation
  { id: "driveModel", page: "world", group: "Offscreen simulation", label: "Drive-sheet model", hint: "Updates each NPC's wants, goals and pressures after settled turns.", keywords: "drives", aria: "Drive update model",
    control: (ctx) => <ModelSelect ctx={ctx} field="driveModel" aria="Drive update model" /> },
  { id: "worldTickModel", page: "world", group: "Offscreen simulation", label: "World tick model", hint: "Simulates what the cast did offscreen when you advance the world.", keywords: "tick", aria: "World tick model",
    control: (ctx) => <ModelSelect ctx={ctx} field="worldTickModel" aria="World tick model" /> },
  { id: "worldTickAutoApply", page: "world", group: "Offscreen simulation", label: "Apply ticks automatically", hint: "Skip the review drawer and apply world-tick events immediately.", keywords: "auto-apply", aria: "World tick auto-apply",
    control: (ctx) => <Switch ctx={ctx} field="worldTickAutoApply" aria="World tick auto-apply" /> },
  { id: "advance", page: "world", group: "Offscreen simulation", label: "Advance the world", hint: "Simulate offscreen activity now; proposals are reviewed before anything becomes canon.", keywords: "advance tick simulate", aria: "Advance…", when: (ctx) => ctx.hasCampaign, requires: "the session belongs to a campaign",
    control: (ctx) => <button type="button" className="secondary-button" onClick={ctx.onAdvanceWorld} disabled={ctx.disabled}><Icon name="globe" size={13} /> Advance…</button> },
  // World · Dramatist
  { id: "dramatistEnabled", page: "world", group: "Dramatist", label: "Dramatist", hint: "Periodically arms grounded complications from live threads, beats, concealments and sealed schemes.", keywords: "complications", aria: "Dramatist enabled",
    control: (ctx) => <Switch ctx={ctx} field="dramatistEnabled" aria="Dramatist enabled" /> },
  { id: "dramatistIntensity", page: "world", group: "Dramatist", label: "Intensity", keywords: "restrained standard bold", aria: "Dramatist intensity",
    control: (ctx) => <Choice ctx={ctx} field="dramatistIntensity" aria="Dramatist intensity" options={[["restrained", "Restrained"], ["standard", "Standard"], ["bold", "Bold"]]} /> },
  { id: "tickEveryNthRollingDiff", page: "world", group: "Dramatist", label: "Tick cadence", hint: "Run the Dramatist every N rolling diffs.", keywords: "every nth", aria: "Dramatist rolling diff cadence",
    control: (ctx) => <Num ctx={ctx} field="tickEveryNthRollingDiff" aria="Dramatist rolling diff cadence" min={1} max={20} step={1} width={56} unit="diffs" /> },
  { id: "dramatistModel", page: "world", group: "Dramatist", label: "Dramatist model", aria: "Dramatist model",
    control: (ctx) => <ModelSelect ctx={ctx} field="dramatistModel" aria="Dramatist model" /> },

  // Workers · All workers
  { id: "pipelineAutoEnabled", page: "workers", group: "All workers", label: "Automatic workers", hint: "Master switch for every auto-enqueued job: rolling diff, repetition, system-prompt audit, consolidation, archival.", keywords: "pipeline auto-enqueue enqueue jobs", aria: "Pipeline auto-enqueue",
    control: (ctx) => <Switch ctx={ctx} field="pipelineAutoEnabled" aria="Pipeline auto-enqueue" /> },
  { id: "workerEffort", page: "workers", group: "All workers", label: "Worker reasoning effort", hint: "For every worker call. Applies to effort-ladder models (GPT, Codex, Grok); Claude bridges keep their own thinking conventions.", keywords: "effort xhigh high medium low thinking", aria: "Pipeline worker reasoning effort",
    control: (ctx) => <Choice ctx={ctx} field="workerEffort" aria="Pipeline worker reasoning effort" options={[["model-max", "Model max (default)"], ["xhigh", "xhigh"], ["high", "high"], ["medium", "medium"], ["low", "low"]]} /> },
  { id: "openaiFastModeEnabled", page: "workers", group: "All workers", label: "OpenAI fast mode", hint: FAST_MODE_HINT, keywords: "fast mode openai priority", aria: "Use Fast Mode for Supported OpenAI Models",
    control: (ctx) => <Switch ctx={ctx} field="openaiFastModeEnabled" aria="Use Fast Mode for Supported OpenAI Models" /> },
  // Workers · Rolling diff — the diff writes lorebook edits from settled turns and is the story-change
  // clock of the workers named in the model hint (pipelineQueueService.evaluateAndEnqueue). There is no
  // switch or cadence of its own: "Automatic workers" stops it, the threshold starts it.
  { id: "rollingModel", page: "workers", group: "Rolling diff", label: "Rolling diff model", hint: "Also runs the thread tracker, consolidation and archival.", keywords: "rolling diff lorebook edits tracker threads consolidation archival", aria: "Rolling diff model",
    control: (ctx) => <ModelSelect ctx={ctx} field="rollingModel" aria="Rolling diff model" /> },
  { id: "rollingDiffCharThreshold", page: "workers", group: "Rolling diff", label: "Rolling diff threshold", hint: "Runs once this many characters of assistant replies have accrued; uses the rolling-diff model above.", keywords: "chars characters threshold", aria: "Rolling diff char threshold", when: (ctx) => ctx.s.pipelineAutoEnabled, requires: "Automatic workers is on", parent: "pipelineAutoEnabled",
    control: (ctx) => <Num ctx={ctx} field="rollingDiffCharThreshold" aria="Rolling diff char threshold" min={1000} max={200000} step={1000} width={84} unit="chars" /> },
  // Workers · Repetition and system prompt
  { id: "repetitionCharThreshold", page: "workers", group: "Repetition and system prompt", label: "Repetition check threshold", hint: "Scans for narrative repetition once this many characters have accrued.", keywords: "repetition chars", aria: "Repetition char threshold", when: (ctx) => ctx.s.pipelineAutoEnabled, requires: "Automatic workers is on", parent: "pipelineAutoEnabled",
    control: (ctx) => <Num ctx={ctx} field="repetitionCharThreshold" aria="Repetition char threshold" min={5000} max={500000} step={5000} width={84} unit="chars" /> },
  { id: "repetitionModel", page: "workers", group: "Repetition and system prompt", label: "Repetition model", aria: "Repetition detection model", when: (ctx) => ctx.s.pipelineAutoEnabled, requires: "Automatic workers is on", parent: "pipelineAutoEnabled",
    control: (ctx) => <ModelSelect ctx={ctx} field="repetitionModel" aria="Repetition detection model" /> },
  { id: "syspromptAuditCharThreshold", page: "workers", group: "Repetition and system prompt", label: "System prompt audit threshold", hint: "Reviews the system prompt against the turns played since its last review, once this many characters of replies have accrued.", keywords: "sysprompt audit chars drift", aria: "Sysprompt audit char threshold", when: (ctx) => ctx.s.pipelineAutoEnabled, requires: "Automatic workers is on", parent: "pipelineAutoEnabled",
    control: (ctx) => <Num ctx={ctx} field="syspromptAuditCharThreshold" aria="Sysprompt audit char threshold" min={10000} max={1000000} step={10000} width={96} unit="chars" /> },
  { id: "syspromptAuditModel", page: "workers", group: "Repetition and system prompt", label: "System prompt audit model", keywords: "sysprompt", aria: "Sysprompt audit model", when: (ctx) => ctx.s.pipelineAutoEnabled, requires: "Automatic workers is on", parent: "pipelineAutoEnabled",
    control: (ctx) => <ModelSelect ctx={ctx} field="syspromptAuditModel" aria="Sysprompt audit model" /> },
  // Workers · Anti-repetition rules
  { id: "maxAntiRepetitionRules", page: "workers", group: "Anti-repetition rules", label: "Maximum rules", hint: "Cap on the ban / limit / vary rules injected into the system prompt.", keywords: "anti-repetition rules ban limit vary max", aria: "Max anti-repetition rules",
    control: (ctx) => <Num ctx={ctx} field="maxAntiRepetitionRules" aria="Max anti-repetition rules" min={10} max={300} width={64} /> },
  { id: "antiRepArchiveAfter", page: "workers", group: "Anti-repetition rules", label: "Retire rules after", hint: "A rule the detector stops matching for this many runs is archived.", keywords: "archive unmatched runs retire", aria: "Anti-rep archive after N runs unmatched",
    control: (ctx) => <Num ctx={ctx} field="antiRepArchiveAfter" aria="Anti-rep archive after N runs unmatched" min={2} max={20} width={56} unit="unmatched runs" /> },

  // Audit · Campaign audit
  { id: "auditModel", page: "audit", group: "Campaign audit", label: "Audit model", aria: "Campaign audit model",
    control: (ctx) => <ModelSelect ctx={ctx} field="auditModel" aria="Campaign audit model" /> },
  { id: "auditAutoEnabled", page: "audit", group: "Campaign audit", label: "Automatic audits", hint: "Run audits as lorebook entries change: a quick one at the small threshold, a full one at the large threshold with a 30-day floor.", keywords: "auto audits", aria: "Audit auto",
    control: (ctx) => <Switch ctx={ctx} field="auditAutoEnabled" aria="Audit auto" /> },
  { id: "auditQuickEveryNChanges", page: "audit", group: "Campaign audit", label: "Quick audit every", hint: "Entry changes between quick audits.", keywords: "quick changes", aria: "Quick audit entry-change threshold", when: (ctx) => ctx.s.auditAutoEnabled, requires: "Automatic audits is on", parent: "auditAutoEnabled",
    control: (ctx) => <Num ctx={ctx} field="auditQuickEveryNChanges" aria="Quick audit entry-change threshold" min={10} max={1000} step={10} width={72} unit="changes" /> },
  { id: "auditFullEveryNChanges", page: "audit", group: "Campaign audit", label: "Full audit every", hint: "Entry changes between full audits, never more often than every 30 days.", keywords: "full changes", aria: "Full audit entry-change threshold", when: (ctx) => ctx.s.auditAutoEnabled, requires: "Automatic audits is on", parent: "auditAutoEnabled",
    control: (ctx) => <Num ctx={ctx} field="auditFullEveryNChanges" aria="Full audit entry-change threshold" min={50} max={5000} step={50} width={72} unit="changes" /> },
];

const visible = (row: RowDef, ctx: Ctx) => !row.when || row.when(ctx);

function Row({ row, ctx, flash, hidden }: { row: RowDef; ctx: Ctx; flash: boolean; hidden?: boolean }) {
  // A non-admin sees an admin-only dial's value, never an editable control.
  const locked = isAdminOnlyRow(row) && !ctx.isAdmin;
  const controlCtx = locked ? { ...ctx, disabled: true } : ctx;
  return (
    <div id={`eng-row-${row.id}`} className={`eng-row${flash ? " is-flash" : ""}${hidden ? " is-hidden" : ""}`}>
      <div className="eng-row-text">
        <span className="eng-label">{row.label}</span>
        {row.hint ? <span className="eng-hint">{row.hint}</span> : null}
        {locked ? <span className="eng-hint eng-locked"><Icon name="shield" size={11} /> Set by an admin.</span> : null}
        {hidden ? <span className="eng-hint eng-requires"><Icon name="eye" size={11} /> Shown when {row.requires}.</span> : null}
      </div>
      {hidden ? null : (
        <div className="eng-ctl">
          {ctx.fragmentsFor(row.id).length > 0 ? (
            <button type="button" className="eng-textbtn" title="View the text this setting injects" aria-label={`View injected text for ${row.label}`} onClick={() => ctx.openText(row.id)}>
              <Icon name="scroll" size={13} />
            </button>
          ) : null}
          {row.control(controlCtx)}
        </div>
      )}
    </div>
  );
}

const LEVEL_LABEL: Record<PromptFragment["level"], string> = { system: "System text · read-only", campaign: "Campaign", dynamic: "Composed per turn" };
const EDIT_IN_LABEL: Record<NonNullable<PromptFragment["editIn"]>, string> = { drives: "Drives", lorebook: "Lorebook", campaign: "Campaigns" };

/**
 * The read-only viewer: every block the engine wraps around the campaign prompt, in wire order,
 * from the server's own builders. Opened from a row (scrolls to that setting's blocks and marks
 * them) or from the dialog header (everything).
 */
function InjectedTextDialog({ open, onClose, fragments, status, focus, onOpenDrives }: { open: boolean; onClose: () => void; fragments: PromptFragment[]; status: "pending" | "error" | "success"; focus: string | null; onOpenDrives?: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const focused = useMemo(() => new Set(focus ? fragments.filter((f) => f.settings.includes(focus)).map((f) => f.id) : []), [fragments, focus]);
  useEffect(() => {
    if (!open || focused.size === 0) return;
    const first = fragments.find((f) => focused.has(f.id));
    const timer = window.setTimeout(() => document.getElementById(`frag-${first?.id}`)?.scrollIntoView({ block: "start" }), 60);
    return () => window.clearTimeout(timer);
  }, [open, focused, fragments]);
  const groups: Array<{ name: string; items: PromptFragment[] }> = [];
  for (const f of fragments) {
    const last = groups[groups.length - 1];
    if (last && last.name === f.group) last.items.push(f);
    else groups.push({ name: f.group, items: [f] });
  }
  const copy = (f: PromptFragment) => {
    if (!f.text) return;
    const text = f.text;
    const done = () => { setCopied(f.id); window.setTimeout(() => setCopied((c) => (c === f.id ? null : c)), 1500); };
    // The async clipboard needs a secure context and permission; fall back to the selection copy.
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select();
      try { document.execCommand("copy"); done(); } finally { area.remove(); }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  };
  return (
    <Dialog open={open} onClose={onClose} label="Injected text" eyebrow="Context Engine" title="Injected text" icon="scroll" size="xl" zIndex={2500} className="frag-dialog">
      <p className="eng-blurb">Everything the engine adds around your campaign prompt for this session, in the order the model reads it. Each block says where it comes from and how, or whether, you can change it.</p>
      {status === "pending" ? <p className="eng-hint">Loading…</p> : null}
      {status === "error" ? <p className="eng-hint">Could not load the injected text. Close and try again.</p> : null}
      {groups.map((g) => (
        <section className="frag-group" key={g.name}>
          <h4 className="eng-group-title">{g.name}</h4>
          {g.items.map((f) => (
            <article id={`frag-${f.id}`} className={`frag-card${f.active ? "" : " is-off"}${focused.has(f.id) ? " is-focus" : ""}`} key={f.id}>
              <header className="frag-head">
                <span className="frag-title">{f.title}</span>
                <span className={`frag-badge level-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
                <span className={`frag-badge ${f.active ? "is-on" : "is-off"}`}>{f.active ? "Injected" : "Not injected"}</span>
                {f.text ? <button type="button" className="frag-copy" onClick={() => copy(f)} aria-label={`Copy ${f.title}`}>{copied === f.id ? "Copied" : "Copy"}</button> : null}
              </header>
              <dl className="frag-meta">
                <div><dt>Where</dt><dd>{f.placement}</dd></div>
                <div><dt>From</dt><dd>{f.origin}</dd></div>
                <div><dt>Editing</dt><dd>{f.editing}</dd></div>
                {f.note ? <div><dt>Now</dt><dd>{f.note}</dd></div> : null}
              </dl>
              {f.text ? <pre className="frag-text">{f.text}</pre> : null}
              {f.editIn === "drives" && onOpenDrives ? <button type="button" className="secondary-button frag-edit" onClick={onOpenDrives}><Icon name="pencil" size={12} /> Edit in Drives</button> : f.editIn ? <span className="frag-place">Edited in the {EDIT_IN_LABEL[f.editIn]} panel.</span> : null}
            </article>
          ))}
        </section>
      ))}
    </Dialog>
  );
}

/** Rows grouped in first-seen order (the table's order is the display order). */
function groupRows(rows: RowDef[]): Array<{ group: string; rows: RowDef[] }> {
  const out: Array<{ group: string; rows: RowDef[] }> = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else out.push({ group: row.group, rows: [row] });
  }
  return out;
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9%×+ ]+/g, " ").replace(/\s+/g, " ").trim();
function matches(row: RowDef, query: string): number {
  const q = norm(query);
  if (!q) return 0;
  const label = norm(row.label);
  if (label === q) return 4;
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  const hay = norm([row.hint ?? "", row.keywords ?? "", row.aria, row.group, pageLabel(row.page), row.requires ?? ""].join(" "));
  return q.split(" ").every((term) => hay.includes(term) || label.includes(term)) ? 1 : 0;
}

type Props = {
  open: boolean;
  onClose: () => void;
  settings: ContextSettings;
  save: (payload: Record<string, unknown>) => Promise<void> | void;
  disabled: boolean;
  models: ReadonlyArray<AvailableChatModel>;
  config: ProviderKeyListResponse | undefined;
  hasCampaign: boolean;
  onAdvanceWorld: () => void;
  sessionId: string;
  modelId: string | null;
  onOpenDrives?: () => void;
  /** Gates the seven adversarial-world rows; the server enforces the same rule. */
  isAdmin: boolean;
};

export function EngineSettingsDialog({ open, onClose, settings, save, disabled, models, config, hasCampaign, onAdvanceWorld, sessionId, modelId, onOpenDrives, isAdmin }: Props) {
  const [page, setPage] = useState<Page>("context");
  const [query, setQuery] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [textView, setTextView] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null });
  // The injected-text catalogue follows the settings (the floor rules change with the stance,
  // the reminder with the names), so the settings are part of the key.
  const fragmentsQuery = useQuery({
    queryKey: ["prompt-fragments", sessionId, modelId, JSON.stringify(settings)],
    queryFn: () => fetchPromptFragments(sessionId, modelId),
    enabled: open,
    staleTime: 30_000,
  });
  const fragments = fragmentsQuery.data?.fragments ?? [];
  const fragmentsBySetting = useMemo(() => {
    const map = new Map<string, PromptFragment[]>();
    for (const f of fragments) for (const id of f.settings) map.set(id, [...(map.get(id) ?? []), f]);
    return map;
  }, [fragments]);
  const ctx: Ctx = {
    s: settings, disabled, set: (patch) => void save({ contextOverrides: patch }), models, config, hasCampaign, onAdvanceWorld,
    fragmentsFor: (rowId) => fragmentsBySetting.get(rowId) ?? [],
    openText: (rowId) => setTextView({ open: true, focus: rowId }),
    isAdmin,
  };
  const searching = query.trim().length > 0;

  // `ranked` (best label match first) picks the row Enter opens; `results` keeps the table's
  // page/group order so a group is listed once with all its hits under one heading.
  const ranked = useMemo(() => {
    if (!searching) return [];
    return ROWS.map((row) => ({ row, score: matches(row, query) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || ROWS.indexOf(a.row) - ROWS.indexOf(b.row)).map((r) => r.row);
  }, [query, searching]);
  const results = useMemo(() => [...ranked].sort((a, b) => ROWS.indexOf(a) - ROWS.indexOf(b)), [ranked]);

  // Jump: open the row's page, scroll it into view and flash it (a hidden row flashes the
  // toggle that reveals it). Runs after the page has rendered.
  const goTo = (row: RowDef) => {
    const target = visible(row, ctx) ? row.id : (row.parent ?? row.id);
    setQuery("");
    setPage(row.page);
    setFlashId(null);
    window.setTimeout(() => setFlashId(target), 0);
  };
  useEffect(() => {
    if (!flashId) return;
    document.getElementById(`eng-row-${flashId}`)?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => setFlashId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flashId]);
  useEffect(() => { if (!open) { setQuery(""); setFlashId(null); } }, [open]);

  const onLayoutKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && searching) { event.preventDefault(); setQuery(""); }
    if (event.key === "Enter" && ranked.length > 0) { event.preventDefault(); goTo(ranked[0]); }
  };

  const current = PAGES.find((p) => p.id === page)!;
  const pageRows = ROWS.filter((row) => row.page === page && visible(row, ctx));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Context Engine"
      eyebrow="Session"
      title="Context Engine"
      icon="sliders"
      size="wide"
      className="engine-dialog"
      bodyClassName="dialog-body-flush"
      closeOnEscape={!searching}
      headerExtra={<button type="button" className="secondary-button eng-headbtn" onClick={() => ctx.openText(null)} title="Every block the engine injects for this session, in wire order"><Icon name="scroll" size={13} /> Injected text</button>}
    >
      <InjectedTextDialog open={textView.open} onClose={() => setTextView({ open: false, focus: null })} fragments={fragments} status={fragmentsQuery.status} focus={textView.focus} onOpenDrives={onOpenDrives} />
      <div className="eng-layout" onKeyDown={onLayoutKey}>
        <nav className="eng-nav" aria-label="Engine settings pages">
          <label className="eng-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} type="search" placeholder="Search settings" aria-label="Search engine settings" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKey} autoComplete="off" spellCheck={false} />
          </label>
          <div className="eng-nav-pages">
            {PAGES.map((p) => (
              <button key={p.id} type="button" className={`eng-nav-btn${!searching && page === p.id ? " is-active" : ""}`} aria-current={!searching && page === p.id ? "page" : undefined} onClick={() => { setQuery(""); setPage(p.id); }}>
                <Icon name={p.icon} size={15} /> {p.label}
              </button>
            ))}
          </div>
          <p className="eng-nav-note">Settings are per session; new sessions inherit the campaign's newest.</p>
        </nav>

        {searching ? (
          <div className="eng-page" key="search" role="region" aria-label="Search results" aria-live="polite">
            <p className="eng-blurb">
              {results.length === 0 ? <>No setting matches “{query}”.</> : <>{results.length} {results.length === 1 ? "setting matches" : "settings match"} “{query}”. Enter opens the first; a heading opens its page.</>}
            </p>
            {PAGES.map((p) => {
              const rows = results.filter((row) => row.page === p.id);
              if (rows.length === 0) return null;
              return groupRows(rows).map(({ group, rows: groupRows_ }) => (
                <section className="eng-group" key={`${p.id}/${group}`}>
                  <button type="button" className="eng-group-title eng-jump" onClick={() => goTo(groupRows_[0])} title={`Open ${p.label} › ${group}`}>
                    <Icon name={p.icon} size={12} /> {p.label} <span className="eng-jump-sep">›</span> {group} <Icon name="chevron-right" size={12} />
                  </button>
                  {groupRows_.map((row) => <Row key={row.id} row={row} ctx={ctx} flash={false} hidden={!visible(row, ctx)} />)}
                </section>
              ));
            })}
          </div>
        ) : (
          <div className="eng-page" key={page}>
            <p className="eng-blurb">{current.blurb}</p>
            {groupRows(pageRows).map(({ group, rows }) => (
              <section className="eng-group" key={group}>
                <h4 className="eng-group-title">{group}</h4>
                {rows.map((row) => <Row key={row.id} row={row} ctx={ctx} flash={flashId === row.id} />)}
              </section>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// Exported for the unit tests (the dialog renders one page at a time; the tests read the table).
export { ROWS as ENGINE_ROWS, Row as EngineRow, matches as matchEngineRow, isAdminOnlyRow };
export type { Ctx as EngineRowContext, RowDef as EngineRowDef };
