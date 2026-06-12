import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { recordSystemEvent } from "../system/systemEvents";
import type { SceneState } from "./sceneParser";

export interface SceneValidatorUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SceneValidatorAttireEntry {
  description: string;
  changed: boolean;
  reason?: string;
}

export interface SceneValidatorVerdict {
  agreement: "agree" | "disagree";
  present: string[];
  presentUnaware: string[];
  rationale: string;
  attire: Record<string, SceneValidatorAttireEntry>;
}

export interface SceneValidatorResult {
  verdict: SceneValidatorVerdict | null;
  usage: SceneValidatorUsage | null;
  rawResponse: string;
}

export interface SceneValidatorTurn {
  role: "user" | "assistant";
  content: string;
  scene?: { location: string | null; present: string[]; presentUnaware: string[] } | null;
}

export interface SceneValidatorInput {
  runtime: ChatRuntime | null;
  modelId: string;
  history: SceneValidatorTurn[];
  declared: SceneState;
  attireBefore?: Record<string, string>;
  attireAdvisory?: Record<string, string>;
  trackAttire?: boolean;
  requestId?: string;
  // For no-silent-failure event recording on validator errors.
  userId?: string;
  sessionId?: string | null;
}

const PRESENCE_RULES = `You are an independent scene-state auditor for a collaborative-fiction chat.
You will receive the last several turns of a roleplay, plus the main author's declared scene state for the latest assistant turn (LOCATION, PRESENT list, PRESENT_UNAWARE list).
Your job: decide whether the main author's PRESENT and PRESENT_UNAWARE lists for the latest assistant turn are correct, given the prior narrative.

A character belongs in PRESENT if they are physically in the current scene/location and conscious/aware.
A character belongs in PRESENT_UNAWARE if they are physically in the scene but cannot perceive it (asleep, unconscious, knocked out, in another room overhearing but unable to act).
A character does NOT belong in either list if they:
- Are in a different location (different building, different room across a sealed door, different city, different dimension)
- Have departed the scene in a prior turn and not returned
- Are dead
- Are merely being discussed, remembered, or referenced
- Are arriving "in a moment" but have not yet entered`;

const PRESENCE_OUTPUT = `Output strict JSON only, no prose:
{"agreement":"agree"|"disagree","present":[...],"present_unaware":[...],"rationale":"..."}

- If you agree with the main author, set agreement="agree" and copy their lists exactly.
- If you disagree, set agreement="disagree" and supply the corrected lists.
- Use clean character names (no parenthetical annotations). No group descriptors like "two guards".
- Keep rationale under 200 characters. Cite the turn where the discrepancy is visible.`;

const ATTIRE_RULES = `Additionally, audit each character's CURRENT ATTIRE based on the narrative.
You are given each present character's PRIOR ATTIRE (the last recorded outfit before this turn) — but only for the characters the author DECLARED as present. If you correct the present/unaware lists (i.e., your output disagrees with the author's), there may be characters in your corrected lists who have no prior_attire entry. You must still emit attire for them.

You may also be given the author's ATTIRE_ADVISORY — what the author claims attire is for this turn. Treat the advisory as a hint, NOT as truth.

Read the latest assistant turn carefully. **For every character in YOUR corrected "present" and "present_unaware" output lists (including any you added via disagreement)**, emit an attire entry:
- If the narrative explicitly changes their attire (donned, removed, torn, swapped, bloodied, scorched, etc.), emit the post-action attire as a complete prose description. Set changed=true.
- If the narrative does not change attire and prior_attire was provided, emit the prior attire VERBATIM and set changed=false.
- If you have no prior attire (character was added via disagreement, or this is a new character) AND the narrative does not establish attire, infer plausible attire from context (location, time of day, character role, prior firmware descriptions in recent_turns). Set changed=true so the new state is stored.
- Damage and soiling count as attire state (e.g., "bloodied tunic", "scorched left boot", "torn sleeve hanging").
- A character in PRESENT_UNAWARE only changes attire if the narrative explicitly does something to them (someone dresses them, undresses them, blood soaks through, etc.).
- Use one-line prose per character. No structured fields. No JSON nesting beyond the top-level map.
- Do NOT emit attire for characters absent from your final present/unaware lists, even if they appear in the narrative as off-screen references.`;

const ATTIRE_OUTPUT = `Extend your JSON output with an "attire" object keyed by character name. Each entry has:
{"description":"...","changed":true|false,"reason":"..."}
Where description is the post-turn attire prose, changed is whether you updated it from prior, and reason briefly cites the narrative moment when changed=true (omit when changed=false).

Full output shape:
{"agreement":"agree"|"disagree","present":[...],"present_unaware":[...],"rationale":"...","attire":{"CharacterName":{"description":"...","changed":bool,"reason":"..."}}}`;

function buildSystemPrompt(trackAttire: boolean): string {
  if (!trackAttire) return `${PRESENCE_RULES}\n\n${PRESENCE_OUTPUT}`;
  return `${PRESENCE_RULES}\n\n${ATTIRE_RULES}\n\n${ATTIRE_OUTPUT}`;
}

function formatScene(scene: SceneValidatorTurn["scene"]): string {
  if (!scene || !scene.location) return "";
  const parts = [`SCENE: ${scene.location}`, `PRESENT: ${scene.present.join(", ") || "—"}`];
  if (scene.presentUnaware.length) parts.push(`PRESENT_UNAWARE: ${scene.presentUnaware.join(", ")}`);
  return `[${parts.join(" | ")}] `;
}

function formatAttireMap(label: string, attire: Record<string, string>): string {
  const keys = Object.keys(attire);
  if (keys.length === 0) return "";
  const lines = [`<${label}>`];
  for (const name of keys) lines.push(`${name}: ${attire[name]}`);
  lines.push(`</${label}>`);
  return lines.join("\n");
}

function buildUserMessage(input: SceneValidatorInput): string {
  const { history, declared, attireBefore, attireAdvisory, trackAttire } = input;
  const lines: string[] = [];
  lines.push("<recent_turns>");
  for (const turn of history) {
    const tag = turn.role === "user" ? "USER" : "ASSISTANT";
    const scene = turn.role === "assistant" ? formatScene(turn.scene) : "";
    const body = turn.content.slice(0, 4000).replace(/\s+/g, " ").trim();
    lines.push(`${tag}: ${scene}${body}`);
  }
  lines.push("</recent_turns>");
  lines.push("");
  lines.push("<declared_scene_for_latest_assistant_turn>");
  lines.push(`LOCATION: ${declared.location}`);
  lines.push(`PRESENT: ${declared.present.join(", ") || "—"}`);
  lines.push(`PRESENT_UNAWARE: ${declared.presentUnaware.join(", ") || "—"}`);
  lines.push("</declared_scene_for_latest_assistant_turn>");
  if (trackAttire) {
    const beforeBlock = formatAttireMap("prior_attire", attireBefore ?? {});
    if (beforeBlock) {
      lines.push("");
      lines.push(beforeBlock);
    }
    const advisoryBlock = formatAttireMap("attire_advisory", attireAdvisory ?? {});
    if (advisoryBlock) {
      lines.push("");
      lines.push(advisoryBlock);
    }
  }
  return lines.join("\n");
}

function parseAttire(raw: unknown): Record<string, SceneValidatorAttireEntry> {
  const out: Record<string, SceneValidatorAttireEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== "string") continue;
    if (!value || typeof value !== "object") continue;
    const v = value as { description?: unknown; changed?: unknown; reason?: unknown };
    const description = typeof v.description === "string" ? v.description.trim() : "";
    if (!description) continue;
    const changed = v.changed === true;
    const reason = typeof v.reason === "string" ? v.reason.slice(0, 240) : undefined;
    out[key.trim()] = { description, changed, reason };
  }
  return out;
}

function parseVerdict(raw: string, declared: SceneState): SceneValidatorVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { agreement?: unknown; present?: unknown; present_unaware?: unknown; rationale?: unknown; attire?: unknown };
  const agreement = obj.agreement === "agree" || obj.agreement === "disagree" ? obj.agreement : null;
  if (!agreement) return null;
  const present = Array.isArray(obj.present) ? obj.present.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [];
  const presentUnaware = Array.isArray(obj.present_unaware) ? obj.present_unaware.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [];
  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 400) : "";
  const attire = parseAttire(obj.attire);
  const declaredPresent = new Set(declared.present);
  const declaredUnaware = new Set(declared.presentUnaware);
  const matchesDeclared =
    present.length === declared.present.length &&
    present.every((p) => declaredPresent.has(p)) &&
    presentUnaware.length === declared.presentUnaware.length &&
    presentUnaware.every((p) => declaredUnaware.has(p));
  const finalAgreement = agreement === "agree" || matchesDeclared ? "agree" : "disagree";
  return {
    agreement: finalAgreement,
    present: finalAgreement === "agree" ? declared.present : present,
    presentUnaware: finalAgreement === "agree" ? declared.presentUnaware : presentUnaware,
    rationale,
    attire,
  };
}

export async function runSceneValidator(input: SceneValidatorInput): Promise<SceneValidatorResult> {
  const { runtime, modelId, history, declared, requestId, trackAttire = false } = input;
  if (!runtime || history.length === 0) return { verdict: null, usage: null, rawResponse: "" };
  const userMessage = buildUserMessage(input);
  let responseText = "";
  let capturedUsage: SceneValidatorUsage | null = null;
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: buildSystemPrompt(trackAttire),
      messages: [{ role: "user", content: userMessage, attachments: [] }],
      temperature: 0,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: requestId ?? `scene-validator-${Date.now()}`,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: (result) => {
        capturedUsage = {
          modelId,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        };
      },
    });
  } catch (err) {
    // No-silent-failures: a dead validator means presence/attire drift goes
    // unchecked — record it (userId optional for back-compat callers).
    if (input.userId) {
      recordSystemEvent({
        userId: input.userId,
        source: "scene_validator",
        message: `scene validator failed (${modelId}): ${err instanceof Error ? err.message : String(err)}`,
        sessionId: input.sessionId ?? null,
      });
    }
    return { verdict: null, usage: capturedUsage, rawResponse: responseText };
  }
  const verdict = parseVerdict(responseText, declared);
  return { verdict, usage: capturedUsage, rawResponse: responseText };
}
