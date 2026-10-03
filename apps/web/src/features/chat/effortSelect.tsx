import { composerEffortOnWire, type ChatModel, type EffortLevel } from "@tracyhill-rp/model-catalog";

// The Session popover's Effort select. It used to show
// `session.effort ?? "medium"`: a null effort read "Medium" though no runtime runs medium for it,
// and a stored rung outside the ladder rendered as the select's first option. It now shows the
// effort the composer turn puts on the wire (`composerEffortOnWire`, pinned to every runtime by
// the provider-runtime tests), says when that differs from the saved value, and
// leaves the saved value alone until the user picks another.
//
// Google effort models (Gemini 3.x) cannot turn
// thinking off. Thinking mode "off" runs their lowest level and forwards the session temperature
// (provider-runtime buildGeminiGenerationConfig). The web never writes "off" for them, but a
// session can hold it (an API or Android PATCH, a campaign part cloned from such a session), and
// then nothing on the web turned thinking back on: the select showed the lowest level and a pick
// saved only `effort`, which the runtime ignores while thinking is off. In that state the select
// now reads "Off (lowest level)", and picking a level saves thinking on with it.
//
// Thinking off is the only Gemini 3.x state with a working temperature
// dial, and a session with thinking on could never get there. "Off (lowest level)" is now a real choice in every
// mode: picking it saves `{ thinkingMode: "off" }`, and while thinking is off it is the selected entry.

const RANK: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function effortLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}

export type EffortSelectState = {
  options: EffortLevel[];
  /** The select's value: the effort that runs, or "" when none is sent. */
  value: string;
  /** A disabled option carrying `value` when `options` do not hold it. */
  placeholder: { value: string; label: string } | null;
  /** Gemini 3.x: "Off (lowest level)" is offered as a real choice, first, in every thinking mode. */
  offChoice: boolean;
  /** Why the select shows something other than the saved effort; undefined when they match. */
  title: string | undefined;
};

/** The select's value for the Gemini 3.x thinking-off entry. */
export const EFFORT_OFF_VALUE = "off";
const OFF_LABEL = "Off (lowest level)";
const OFF_TITLE = "Turns thinking off. This model then runs its lowest level and uses the session temperature.";

/** Gemini 3.x: thinking cannot be disabled; "off" runs the lowest level and is the only mode that honours temperature. */
function geminiThinkingChoice(model: ChatModel): boolean {
  return model.provider === "google" && Boolean(model.supportsEffort) && !model.thinkingAlwaysOn;
}

function geminiThinkingOff(model: ChatModel, thinkingMode: string): boolean {
  return geminiThinkingChoice(model) && thinkingMode === "off";
}

export function effortSelectState(model: ChatModel, saved: EffortLevel | null | undefined, thinkingMode: string): EffortSelectState {
  const all = model.effortOptions ?? ["low", "medium", "high"];
  // Opus 5 family (thinkingDefaultOn): disabled thinking caps effort at thinkingOffMaxEffort, so
  // the rungs above it are hidden while the dial is Off; flipping thinking back on restores them.
  const cap = model.thinkingDefaultOn && thinkingMode === "off" ? model.thinkingOffMaxEffort : undefined;
  const options = cap ? all.filter((e) => RANK.indexOf(e) <= RANK.indexOf(cap)) : all;
  const runs = composerEffortOnWire(model, saved, thinkingMode);
  const offChoice = geminiThinkingChoice(model);
  if (geminiThinkingOff(model, thinkingMode)) {
    return {
      options,
      value: EFFORT_OFF_VALUE,
      placeholder: null,
      offChoice,
      title: `Thinking is off for this session. This model cannot turn thinking off, so it runs its lowest level (${effortLabel(runs ?? "low")}) and uses the session temperature. Pick a level to turn thinking on. The model then runs at temperature 1.`,
    };
  }
  const placeholder = runs === null ? { value: "", label: "Provider default" } : options.includes(runs) ? null : { value: runs, label: effortLabel(runs) };
  const savedText = saved ? `Saved as ${effortLabel(saved)}.` : "No effort is saved.";
  const title = runs === (saved ?? null) ? undefined
    : runs ? `${savedText} This model runs ${effortLabel(runs)}.`
    : `${savedText} No effort is sent, so the provider's default applies.`;
  return { options, value: runs ?? "", placeholder, offChoice, title };
}

export function EffortSelect({ model, saved, thinkingMode, ariaLabel, disabled, onChange }: {
  model: ChatModel;
  saved: EffortLevel | null | undefined;
  thinkingMode: string;
  ariaLabel: string;
  disabled: boolean;
  onChange: (settings: EffortChangeSettings) => void;
}) {
  const state = effortSelectState(model, saved, thinkingMode);
  return (
    <select aria-label={ariaLabel} value={state.value} title={state.title} disabled={disabled} onChange={(event) => onChange(effortChangeSettings(model, thinkingMode, event.target.value))}>
      {state.placeholder ? <option value={state.placeholder.value} disabled>{state.placeholder.label}</option> : null}
      {state.offChoice ? <option value={EFFORT_OFF_VALUE} title={OFF_TITLE}>{OFF_LABEL}</option> : null}
      {state.options.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
    </select>
  );
}

export type EffortChangeSettings = { effort: string; thinkingMode?: "enabled" } | { thinkingMode: "off" };

/**
 * The session settings a pick from the select saves: the level, and thinking on when a Gemini 3.x session had it off;
 * for Gemini 3.x, "Off (lowest level)" saves thinking off alone and keeps the saved level for later.
 */
export function effortChangeSettings(model: ChatModel, thinkingMode: string, effort: string): EffortChangeSettings {
  if (effort === EFFORT_OFF_VALUE && geminiThinkingChoice(model)) return { thinkingMode: "off" };
  return geminiThinkingOff(model, thinkingMode) ? { effort, thinkingMode: "enabled" } : { effort };
}
