import { getChatModel } from "@tracyhill-rp/model-catalog";

import type { AvailableChatModel } from "../auth/providerKeyApi";

/**
 * Whether the Session popover shows the Temperature dial: never for a model
 * whose runtime would ignore it (a dial that silently does nothing),
 * and for thinking-capable models only while the thinking MODE is Off, the
 * only state in which their runtimes forward the caller's temperature (or, for
 * the toggle models, their providers are taken to honour it). The exception is
 * a toggle model measured honouring it while it thinks (GLM-5.2,
 * `temperatureWhileThinking`, 2026-10-01).
 *
 * Google effort models (Gemini 3.x) cannot
 * disable thinking on the wire — "off" selects the lowest legal level and
 * forwards the temperature, every other mode pins `temperature: 1`.
 * The old clause hid the dial for them in every
 * mode; dropping it outright would have shown a dead knob while thinking is
 * on. The mode gate is what makes the dial honest, matching Android's
 * `!thinkingActive && supportsTemperature`.
 *
 * The z.ai and custom-Responses
 * clauses are gone. The z.ai runtime sends the caller's `temperature` (default
 * 1) with thinking off and on, for every entry that has the dial; an entry
 * flagged `supportsTemperature: false` gets none (GLM-5.3 and GLM-5.3 Flash
 * since 2026-10-01: z.ai ignores it while they reason, which they always
 * do), and the flag check below hides its dial. The runtime hard-coded 1.0
 * only at the V2 launch, fixed 2026-06-10. The Responses runtime forwards the
 * temperature for a custom endpoint unless the endpoint's model id resolves to
 * a catalog reasoning model, which gets `reasoning` instead.
 * The provider-runtime tests pin these facts ("temperature
 * on the wire" and "no temperature on the wire for a model without the dial").
 */
export function showTemperatureControlFor(model: AvailableChatModel | null, thinkingMode: string): boolean {
  if (!model) return false;
  // Catalog capability flag (derived in model-catalog for OpenAI/CodexBridge
  // reasoning-effort models and the adaptive-only Anthropic entries).
  if (model.supportsTemperature === false) return false;
  // A custom Responses endpoint serving a catalog reasoning model id: the
  // runtime resolves the id in the catalog and sends `reasoning`, never the
  // temperature (createOpenAICompatibleResponsesRuntime).
  if (model.apiFormat === "responses" && model.actualModelId && getChatModel(model.actualModelId)?.supportsEffort) return false;
  const thinkingOff = thinkingMode === "off";
  if (model.supportsThinkingBudget && !thinkingOff) return false;
  if (model.supportsAdaptiveThinking && !thinkingOff) return false;
  // Toggle-thinking models hide the dial while they reason, where their
  // providers are taken to ignore it, unless a measurement showed the provider
  // honours it then (`temperatureWhileThinking`: GLM-5.2 only, measured 2026-10-01,
  // the numbers on its catalog entry). DeepSeek V4, MiMo and the other GLMs are
  // unmeasured and stay hidden.
  if (model.supportsToggleThinking && !thinkingOff && !model.temperatureWhileThinking) return false;
  if (model.supportsEffort && model.provider === "google" && !thinkingOff) return false;
  return true;
}
