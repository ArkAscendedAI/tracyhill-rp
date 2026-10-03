import type { AvailableChatModel } from "../auth/providerKeyApi";

type BudgetModel = Pick<AvailableChatModel, "provider" | "maxThinkingBudget">;

// The popover floored every budget model at 128, but the
// Anthropic Messages runtime (direct, and the Claude subscription runner's bridge models) sends
// `budget_tokens: clamp(budget ?? max, 1024, max)`, so 128 to 1023 silently ran at 1024. Gemini
// 2.5 clamps to [128, max]. The provider-runtime tests pin both clamps.
const anthropicDialect = (provider: string) => provider === "anthropic" || provider === "claude-code";

/** The range the runtime accepts for this model's thinking budget (its maximum is the runtime's fallback too). */
export function thinkingBudgetBounds(model: BudgetModel): { min: number; max: number } {
  const anthropic = anthropicDialect(model.provider);
  const max = model.maxThinkingBudget ?? (anthropic ? 4095 : 24576);
  return { min: Math.min(anthropic ? 1024 : 128, max), max };
}

/**
 * The budget the runtime sends for the stored value, which is what the popover displays: unset
 * means the maximum, and a value outside the range is clamped. The stored value itself is left
 * alone until the user picks a new one, as with the effort cap while thinking is off.
 */
export function effectiveThinkingBudget(model: BudgetModel, stored: number | null | undefined): number {
  const { min, max } = thinkingBudgetBounds(model);
  return Math.min(max, Math.max(min, stored ?? max));
}
