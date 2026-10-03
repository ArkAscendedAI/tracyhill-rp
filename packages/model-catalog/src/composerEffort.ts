import type { ChatModel, EffortLevel } from "./index";

// The reasoning effort a composer turn actually puts on the wire, in catalog vocabulary, for a
// session's stored effort and thinking mode. The web's Effort
// select used to show `session.effort ?? "medium"`: a null effort read "Medium" although no
// runtime runs medium for it, and a rung outside the model's ladder rendered as the select's
// first option. Each branch below mirrors one runtime's own resolution; the provider-runtime
// tests (and the API's codexBridgeRuntime test for the bridge) drive
// the real runtimes over every catalog effort model, effort and thinking mode and require this
// function to agree, so a runtime change cannot drift from it silently.
//
// null = the runtime sends no effort, so the provider's own default applies.

const LADDER: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// provider-runtime `foldEffortToLadder`: an exact rung passes, a level above the ladder folds down
// to the nearest rung, a level below its floor folds up to the floor.
function fold(effort: EffortLevel, rungs: readonly EffortLevel[]): EffortLevel {
  if (!rungs.length || rungs.includes(effort)) return effort;
  const rank = LADDER.indexOf(effort);
  for (let i = rank - 1; i >= 0; i--) if (rungs.includes(LADDER[i])) return LADDER[i];
  for (let i = rank + 1; i < LADDER.length; i++) if (rungs.includes(LADDER[i])) return LADDER[i];
  return effort;
}

// Kimi K3's documented ladder is low|high|max (provider-runtime `mapMoonshotEffort`).
function kimiK3Rung(effort: EffortLevel): EffortLevel {
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  if (effort === "medium" || effort === "high") return "high";
  return "max";
}

// DeepSeek's documented ladder is also low|high|max, but DeepSeek runs xhigh as high
// (provider-runtime `mapDeepSeekEffort`).
function deepSeekRung(effort: EffortLevel): EffortLevel {
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  return effort === "max" ? "max" : "high";
}

export function composerEffortOnWire(model: ChatModel, effort: EffortLevel | null | undefined, thinkingMode: string | null | undefined): EffortLevel | null {
  if (!model.supportsEffort) return null;
  const rungs: readonly EffortLevel[] = model.effortOptions ?? [];
  const off = thinkingMode === "off";
  switch (model.provider) {
    case "anthropic":
    case "claude-code": {
      // resolveAnthropicEffort + clampEffortForDisabledThinking: the value passes through (the API
      // accepts levels the picker does not list) except "max" off the ladder, which becomes "high";
      // while thinking is off the Opus 5 family caps it at thinkingOffMaxEffort. Null sends nothing.
      if (!effort) return null;
      const mapped: EffortLevel = effort === "max" && !rungs.includes("max") ? "high" : effort;
      const cap = model.thinkingOffMaxEffort;
      const thinkingOff = !thinkingMode || thinkingMode === "off";
      return thinkingOff && cap && LADDER.indexOf(mapped) > LADDER.indexOf(cap) ? cap : mapped;
    }
    case "openai": {
      // resolveOpenAIResponsesEffort (every OpenAI effort model is on the Responses path).
      if (effort) return rungs.length ? fold(effort, rungs) : effort === "max" ? "high" : effort;
      if (off) {
        if (rungs.includes("none")) return "none";
        if (rungs.length) return fold("none", rungs);
      }
      return "high";
    }
    case "codex-bridge":
      // resolveCodexBridgeEffort (apps/api): fold an explicit effort, else the catalog default.
      return effort && rungs.length ? fold(effort, rungs) : model.defaultEffort ?? "high";
    case "google":
      // buildGeminiGenerationConfig: thinking off runs the lowest legal level whatever the effort;
      // otherwise mapGeminiThinkingLevel (null means "high").
      if (model.thinkingAlwaysOn) return null;
      if (off) return rungs.includes("minimal") ? "minimal" : "low";
      return effort ? fold(effort, rungs.length ? rungs : ["low", "medium", "high"]) : "high";
    case "xai": {
      // mapXaiEffort spells the catalog's "minimal" as the wire's "none"; thinking off with no
      // effort asks for "none"; a ladder without "minimal" cannot take "none" and gets "low".
      const folded = effort ? (rungs.length ? fold(effort, rungs) : effort === "xhigh" || effort === "max" ? "high" : effort) : null;
      const wire = folded ? (folded === "minimal" ? "none" : folded) : off ? "none" : null;
      if (wire === "none") return rungs.includes("minimal") ? "minimal" : "low";
      return wire;
    }
    case "zai": {
      // createZaiChatCompletionsRuntime: effort rides only while thinking runs; mapZaiEffort drops
      // "none" and turns "xhigh" into "high"; an always-on model with thinking off and no effort gets
      // "low"; the result folds DOWN to the model's rungs, and a level below them all lands on the
      // lowest rung (low/medium -> high on GLM-5.2's high|max ladder, 2026-10-01).
      const alwaysOn = Boolean(model.thinkingAlwaysOn);
      if (!alwaysOn && off) return null;
      const mapped: EffortLevel | null = (!effort || effort === "none" ? null : effort === "xhigh" ? "high" : effort) ?? (alwaysOn && off ? "low" : null);
      if (!mapped || !rungs.length || rungs.includes(mapped)) return mapped;
      for (let i = LADDER.indexOf(mapped) - 1; i >= 0; i--) if (rungs.includes(LADDER[i])) return LADDER[i];
      return LADDER.find((rung) => rungs.includes(rung)) ?? null;
    }
    case "moonshot":
      // createMoonshotChatCompletionsRuntime: only the always-on K3 sends an effort.
      if (!model.thinkingAlwaysOn) return null;
      return effort ? kimiK3Rung(effort) : off ? "low" : "max";
    case "fireworks": {
      // mapFireworksEffort: K3-class ladders (with "max") share Kimi K3's fold; K2.6-class tops out
      // at "high". No effort with thinking off lands on "low"; with thinking on, none is sent.
      if (!effort) return off ? "low" : null;
      if (rungs.includes("max")) return kimiK3Rung(effort);
      if (effort === "none" || effort === "minimal" || effort === "low") return "low";
      return effort === "medium" ? "medium" : "high";
    }
    case "deepseek":
      // createDeepSeekChatCompletionsRuntime: the effort rides only while thinking runs (the
      // toggle owns on and off). No effort sends none, so DeepSeek's default (high) applies.
      if (off || !effort) return null;
      return deepSeekRung(effort);
    default:
      // No catalog provider reaches here today (the invariant test fails if one does).
      return effort ?? null;
  }
}
