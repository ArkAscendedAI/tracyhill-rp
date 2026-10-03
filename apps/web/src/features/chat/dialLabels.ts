import type { ChatModel } from "@tracyhill-rp/model-catalog";

// Wording for two capability-driven labels.
// Derived from catalog flags only — never from a provider name (the standing
// rule: "Use model capabilities … not provider allowlists").

/**
 * The disabled Thinking control shown for `thinkingAlwaysOn` entries. Only
 * models whose catalog row says `supportsAdaptiveThinking` run adaptively
 * (the Fable / Opus 5.5 families); GLM-5.3 and Kimi K3 run at the Effort
 * dial's rung, GLM-5.3-flash and Gemini 2.5 Pro at a depth the model sets
 * itself — none of those are "Adaptive" (a mere on/off model is never
 * labelled Adaptive). Meaningful for always-on entries; the
 * caller gates on `thinkingAlwaysOn`.
 */
export function describeAlwaysOnThinking(model: ChatModel): { label: string; title: string } {
  const billed = "and is billed whether or not it is displayed";
  if (model.supportsAdaptiveThinking) {
    return { label: "Adaptive (always on)", title: `Thinking cannot be turned off on this model — it runs adaptively on every request ${billed}.` };
  }
  if (model.supportsEffort) {
    const ladder = (model.effortOptions ?? []).join(" / ");
    return { label: "Always on", title: `Thinking cannot be turned off on this model — it runs on every request at the Effort dial's level (${ladder}) ${billed}.` };
  }
  return { label: "Always on", title: `Thinking cannot be turned off on this model — it runs on every request at a depth the model chooses itself ${billed}.` };
}

const ratioLabel = (ratio: number) => (Number.isInteger(ratio) ? `${ratio}` : ratio.toFixed(1));

/**
 * Tooltip for a message's ⚡ FAST badge (`message.fastMode` — what the provider
 * confirmed). Bridge tiers cost nothing in dollars; priced fast modes are
 * quoted from the model's own catalog rates instead of a fixed "~2× cost".
 */
export function describeFastTurn(model: ChatModel | null): string {
  if (model?.fastServiceTier) {
    return `This turn ran on the bridge's "${model.fastServiceTier}" fast service tier — no extra charge in dollars; it burns the subscription's usage allowance faster.`;
  }
  if (model?.fastModeInputCostPerMillionTokens != null && model.inputCostPerMillionTokens) {
    const inRatio = model.fastModeInputCostPerMillionTokens / model.inputCostPerMillionTokens;
    const outRatio = model.fastModeOutputCostPerMillionTokens != null && model.outputCostPerMillionTokens
      ? model.fastModeOutputCostPerMillionTokens / model.outputCostPerMillionTokens
      : inRatio;
    const rates = inRatio === outRatio ? `~${ratioLabel(inRatio)}× the standard rates` : `~${ratioLabel(inRatio)}× input / ~${ratioLabel(outRatio)}× output rates`;
    return `This turn ran in fast mode — faster output at ${rates} ($${model.fastModeInputCostPerMillionTokens} vs $${model.inputCostPerMillionTokens} per MTok in).`;
  }
  return "This turn ran in fast mode (the provider confirmed the fast tier).";
}
