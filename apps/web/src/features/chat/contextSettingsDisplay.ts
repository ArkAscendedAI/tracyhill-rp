import {
  CONTEXT_DEFAULT_MODEL_DIALS,
  CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS,
  type ContextDefaultModelDial,
  type ContextSettings,
  type ContextSettingsUpdate,
} from "@tracyhill-rp/contracts";

/**
 * The context settings the Engine dialog displays for a session, resolved the way the server's
 * engine resolves them so every dial shows what the session actually runs:
 *   1. the contract's effective defaults, the same frozen object the engine spreads (the
 *      hand-copied literal this replaced had drifted);
 *   2. the deployment's DEFAULT_MODEL_ID, when set, on the chat-model dials the engine replaces:
 *      the contract's CONTEXT_DEFAULT_MODEL_DIALS, which the engine's buildDefaults() reads too
 *      (the web kept its own copy of the nine names);
 *   3. the session's overrides. There is no campaign tier (0077): merging campaign defaults here
 *      would display values the server no longer resolves.
 */
export function resolveDisplayedContextSettings(sessionOverrides: ContextSettingsUpdate | null | undefined, defaultModelOverride: string | null): ContextSettings {
  const modelDials: Partial<Record<ContextDefaultModelDial, string>> = {};
  if (defaultModelOverride) for (const dial of CONTEXT_DEFAULT_MODEL_DIALS) modelDials[dial] = defaultModelOverride;
  return { ...CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS, ...modelDials, ...sessionOverrides };
}
