import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

export interface PresenceNormalizerUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PresenceNormalizerResult {
  present: string[];
  presentUnaware: string[];
  usage: PresenceNormalizerUsage | null;
}

const SYSTEM_PROMPT = `You normalize free-text scene-presence input from a user into canonical character names.
You receive:
- A roster of known canonical character names from this campaign.
- The user's free-text PRESENT list (their attempt at characters physically present and aware).
- The user's free-text PRESENT_UNAWARE list (physically present but unconscious/asleep/unable to perceive).

Map each free-text entry to its closest canonical roster name. Apply spell correction, capitalization, and nickname-to-canonical-name mapping. If a name isn't in the roster, return it as the user wrote it (with proper capitalization) — do not invent characters.

Output strict JSON only, no prose:
{"present":[...],"present_unaware":[...]}

Rules:
- Use clean names only — no parenthetical annotations.
- Reject group descriptors like "two guards"; only named individuals.
- Deduplicate. A name cannot appear in both lists; if there is ambiguity, prefer PRESENT.`;

function parseResult(raw: string): { present: string[]; presentUnaware: string[] } | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { present?: unknown; present_unaware?: unknown };
  const present = Array.isArray(obj.present) ? obj.present.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [];
  const presentUnaware = Array.isArray(obj.present_unaware) ? obj.present_unaware.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [];
  const presentSet = new Set(present);
  const dedupedUnaware = presentUnaware.filter((n) => !presentSet.has(n));
  return { present, presentUnaware: dedupedUnaware };
}

export async function runPresenceNormalizer(input: {
  runtime: ChatRuntime | null;
  modelId: string;
  roster: string[];
  rawPresent: string;
  rawPresentUnaware: string;
  requestId?: string;
}): Promise<PresenceNormalizerResult> {
  const { runtime, modelId, roster, rawPresent, rawPresentUnaware, requestId } = input;
  const trimmedPresent = rawPresent.trim();
  const trimmedUnaware = rawPresentUnaware.trim();
  if (!trimmedPresent && !trimmedUnaware) return { present: [], presentUnaware: [], usage: null };

  // Fallback path: no runtime available, just split on commas
  if (!runtime) {
    const fallback = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    return { present: fallback(trimmedPresent), presentUnaware: fallback(trimmedUnaware), usage: null };
  }

  const userMessage = `<roster>\n${roster.join("\n") || "(empty)"}\n</roster>\n<user_present>${trimmedPresent}</user_present>\n<user_present_unaware>${trimmedUnaware}</user_present_unaware>`;

  let responseText = "";
  let capturedUsage: PresenceNormalizerUsage | null = null;
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage, attachments: [] }],
      temperature: 0,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: requestId ?? `presence-normalizer-${Date.now()}`,
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
  } catch {
    // Fall through to fallback
  }

  const parsed = parseResult(responseText);
  if (parsed) return { ...parsed, usage: capturedUsage };

  // Fallback if LLM failed
  const fallback = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return { present: fallback(trimmedPresent), presentUnaware: fallback(trimmedUnaware), usage: capturedUsage };
}
