import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, type ChatModel, type ProviderId } from "./index";

// Providers where `supportsAdaptiveThinking` is the load-bearing flag for the
// always-on thinking branch. Google's always-on (gemini-2.5-pro) is handled by
// its own runtime branch and never consults supportsAdaptiveThinking, so the
// "thinkingAlwaysOn ⇒ supportsAdaptiveThinking" invariant is scoped to these.
const ANTHROPIC_FAMILY: ProviderId[] = ["anthropic", "claude-code"];
const BRIDGE_SUFFIX = "-bridge";
const CODEX_BRIDGE_SUFFIX = "-codex-bridge";

export type CatalogInvariantResult = { errors: string[]; warnings: string[] };

/**
 * Validates the static model-catalog's internal invariants. Pure and
 * dependency-free so it can run both at API startup and as a unit test.
 *
 * Invariant (1) is a WARNING, not an error: the bridge runtime now resolves
 * max_tokens by the bridge catalog id itself (input.modelId), so a bridge id no
 * longer needs to strip to a catalog id for correctness — the stripped value is
 * only the wire model string. We still surface the asymmetry (claude-haiku-4-5-bridge
 * strips to claude-haiku-4-5, which is not a catalog id — the direct entry is
 * claude-haiku-4-5-20251001) because it was a real footgun before that change.
 * The error-level invariants (2)-(14) catch data inconsistencies that would
 * break a runtime branch or a consumer's arithmetic (cost tiers, the transcript
 * window).
 */
export function checkCatalogInvariants(models: ChatModel[] = CHAT_MODELS): CatalogInvariantResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, ChatModel>();

  // (7) unique ids
  for (const m of models) {
    if (byId.has(m.id)) errors.push(`duplicate model id: ${m.id}`);
    byId.set(m.id, m);
  }

  for (const m of models) {
    // (1) bridge id strips to a catalog id (warning — wire-id asymmetry only)
    if (m.provider === "claude-code" && m.id.endsWith(BRIDGE_SUFFIX)) {
      const stripped = m.id.slice(0, -BRIDGE_SUFFIX.length);
      if (!byId.has(stripped)) {
        warnings.push(`${m.id}: strips to wire id "${stripped}", which is not itself a catalog id`);
      }
    }
    if (m.provider === "codex-bridge") {
      if (!m.id.endsWith(CODEX_BRIDGE_SUFFIX)) errors.push(`${m.id}: CodexBridge ids must end with ${CODEX_BRIDGE_SUFFIX}`);
      else {
        // The live App Server model list is the wire-model authority — the
        // sidecar validates ids against it at call time, so the catalog no
        // longer mirrors that list here (a hardcoded mirror meant adding a
        // model took three synchronized edits). Shape-check only.
        const wireModel = m.id.slice(0, -CODEX_BRIDGE_SUFFIX.length);
        if (!wireModel || wireModel.endsWith("-bridge")) errors.push(`${m.id}: strips to implausible Codex wire model "${wireModel}"`);
      }
    }

    // (2) maxThinkingBudget < maxOutputTokens
    if (m.maxThinkingBudget != null && !(m.maxThinkingBudget < m.maxOutputTokens)) {
      errors.push(`${m.id}: maxThinkingBudget (${m.maxThinkingBudget}) must be < maxOutputTokens (${m.maxOutputTokens})`);
    }

    // (3) defaultEffort ∈ effortOptions
    if (m.defaultEffort != null && m.effortOptions && !m.effortOptions.includes(m.defaultEffort)) {
      errors.push(`${m.id}: defaultEffort "${m.defaultEffort}" not in effortOptions [${m.effortOptions.join(", ")}]`);
    }

    // (4) supportsEffort ⇔ effortOptions has entries
    const hasEffortOptions = Boolean(m.effortOptions && m.effortOptions.length > 0);
    if (Boolean(m.supportsEffort) !== hasEffortOptions) {
      errors.push(`${m.id}: supportsEffort=${Boolean(m.supportsEffort)} disagrees with effortOptions length=${m.effortOptions?.length ?? 0}`);
    }

    // (5) thinkingAlwaysOn ⇒ supportsAdaptiveThinking, and mutually exclusive with
    //     supportsThinkingBudget — Anthropic-family only (see ANTHROPIC_FAMILY note).
    if (m.thinkingAlwaysOn && ANTHROPIC_FAMILY.includes(m.provider)) {
      if (!m.supportsAdaptiveThinking) errors.push(`${m.id}: thinkingAlwaysOn requires supportsAdaptiveThinking`);
      if (m.supportsThinkingBudget) errors.push(`${m.id}: thinkingAlwaysOn is mutually exclusive with supportsThinkingBudget`);
    }

    // (11) thinkingDefaultOn (default-on-but-disableable, Opus 5 family) is
    //      Anthropic-family only; requires supportsAdaptiveThinking and is
    //      mutually exclusive with thinkingAlwaysOn (never-off) and with
    //      supportsThinkingBudget. Its companion thinkingOffMaxEffort requires
    //      thinkingDefaultOn and must be one of the model's effortOptions —
    //      otherwise the runtime clamp and the composer filter disagree.
    if (m.thinkingDefaultOn) {
      if (!ANTHROPIC_FAMILY.includes(m.provider)) errors.push(`${m.id}: thinkingDefaultOn is only meaningful on Anthropic-family providers`);
      if (!m.supportsAdaptiveThinking) errors.push(`${m.id}: thinkingDefaultOn requires supportsAdaptiveThinking`);
      if (m.thinkingAlwaysOn) errors.push(`${m.id}: thinkingDefaultOn is mutually exclusive with thinkingAlwaysOn`);
      if (m.supportsThinkingBudget) errors.push(`${m.id}: thinkingDefaultOn is mutually exclusive with supportsThinkingBudget`);
    }
    if (m.thinkingOffMaxEffort != null) {
      if (!m.thinkingDefaultOn) errors.push(`${m.id}: thinkingOffMaxEffort requires thinkingDefaultOn`);
      if (!m.effortOptions?.includes(m.thinkingOffMaxEffort)) errors.push(`${m.id}: thinkingOffMaxEffort "${m.thinkingOffMaxEffort}" not in effortOptions`);
    }

    // (6) fast-mode input/output costs are both set or both absent
    if ((m.fastModeInputCostPerMillionTokens != null) !== (m.fastModeOutputCostPerMillionTokens != null)) {
      errors.push(`${m.id}: fastMode input/output cost must both be set or both absent`);
    }
    // (6b) fastServiceTier is a CodexBridge-only field, and bridge entries never
    // carry fast pricing (their cost model is the subscription's $0) — the two
    // fast-support signals must not overlap or the UI caption/wire gate diverge.
    if (m.fastServiceTier != null && m.provider !== "codex-bridge") {
      errors.push(`${m.id}: fastServiceTier is only valid on codex-bridge models`);
    }
    if (m.fastServiceTier != null && !m.fastServiceTier.trim()) {
      errors.push(`${m.id}: fastServiceTier must be a non-empty tier id`);
    }
    if (m.provider === "codex-bridge" && m.fastModeInputCostPerMillionTokens != null) {
      errors.push(`${m.id}: codex-bridge models must not carry fast pricing (use fastServiceTier)`);
    }

    // (9) every Google chat model hits exactly one buildGeminiGenerationConfig branch
    if (m.provider === "google") {
      const branches = [m.thinkingAlwaysOn, m.supportsEffort, m.supportsThinkingBudget].filter(Boolean).length;
      if (branches !== 1) {
        errors.push(`${m.id}: google chat model must have exactly one of {thinkingAlwaysOn, supportsEffort, supportsThinkingBudget} (has ${branches})`);
      }
    }

    // (12) a long-context cache-read tier requires a base cache-read rate —
    //      otherwise cached tokens bill $0 below the threshold and the tier
    //      rate above it (the Gemini discontinuity). Same for the
    //      input/output tier rows: a tier without a base is a typo.
    if (m.longContextCacheReadCostPerMillionTokens != null && m.cacheReadCostPerMillionTokens == null) {
      errors.push(`${m.id}: longContextCacheReadCostPerMillionTokens requires a base cacheReadCostPerMillionTokens`);
    }
    if (m.longContextThresholdTokens != null && (m.longContextInputCostPerMillionTokens == null || m.longContextOutputCostPerMillionTokens == null)) {
      errors.push(`${m.id}: longContextThresholdTokens requires longContextInput/OutputCostPerMillionTokens`);
    }

    // (14) apiDefaultEffort — the rung the Anthropic runtime OMITS from the
    //      wire because it equals the API's own default (2026-09-22). It is only
    //      meaningful on the Anthropic family, must be one of the model's
    //      effortOptions, and requires effort support at all; a valid-but-wrong
    //      value (e.g. "high" copied onto a medium-default model) would silently
    //      reproduce the one-rung-lower class the field was added to prevent, so
    //      the unit test pins the two known values.
    if (m.apiDefaultEffort != null) {
      if (!ANTHROPIC_FAMILY.includes(m.provider)) errors.push(`${m.id}: apiDefaultEffort is only meaningful on Anthropic-family providers`);
      if (!m.supportsEffort || !m.effortOptions?.length) errors.push(`${m.id}: apiDefaultEffort requires supportsEffort + effortOptions`);
      else if (!m.effortOptions.includes(m.apiDefaultEffort)) errors.push(`${m.id}: apiDefaultEffort "${m.apiDefaultEffort}" not in effortOptions [${m.effortOptions.join(", ")}]`);
    }

    // (15) temperatureWhileThinking — the dial stays with thinking on for a
    //      toggle-thinking model measured to honour it then (GLM-5.2). It
    //      means nothing without the toggle (other thinking kinds have their own
    //      rules) and contradicts an entry with no dial at all.
    if (m.temperatureWhileThinking) {
      if (!m.supportsToggleThinking) errors.push(`${m.id}: temperatureWhileThinking requires supportsToggleThinking`);
      if (m.supportsTemperature === false) errors.push(`${m.id}: temperatureWhileThinking contradicts supportsTemperature false`);
    }

    // (13) maxOutputTokens < ctx — windowConversation budgets the transcript at
    //      ctx − maxOut and treats a non-positive result as "no model ceiling",
    //      so an entry with maxOut >= ctx silently disables the context guard
    //      (kimi-k3 shipped 1,048,576/1,048,576 that way).
    if (m.ctx != null && !(m.maxOutputTokens < m.ctx)) {
      errors.push(`${m.id}: maxOutputTokens (${m.maxOutputTokens}) must be < ctx (${m.ctx}) or the transcript window loses its model ceiling`);
    }
  }

  // (8) the pinned new-session default resolves (only meaningful against the live catalog)
  if (models === CHAT_MODELS && !byId.has(DEFAULT_CHAT_MODEL_ID)) {
    errors.push(`DEFAULT_CHAT_MODEL_ID "${DEFAULT_CHAT_MODEL_ID}" is not a catalog id`);
  }

  // (10) a DEFAULT_MODEL_ID env override must name a live catalog chat model —
  // otherwise getConfiguredDefaultModelId() ignores it and every surface silently
  // keeps its shipped default, which is exactly the config-does-nothing failure
  // mode this checker exists to surface.
  const envDefault = typeof process === "undefined" ? undefined : process.env?.DEFAULT_MODEL_ID?.trim();
  if (models === CHAT_MODELS && envDefault && !byId.has(envDefault)) {
    errors.push(`DEFAULT_MODEL_ID env override "${envDefault}" is not a catalog chat model id — override ignored, shipped defaults in effect`);
  }

  return { errors, warnings };
}
