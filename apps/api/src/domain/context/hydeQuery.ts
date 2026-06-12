import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { recordSystemEvent } from "../system/systemEvents";

export interface HyDEUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface HyDEResult {
  hypothesis: string | null;
  usage: HyDEUsage | null;
}

export async function generateHyDEQuery(
  runtime: ChatRuntime | null,
  modelId: string,
  userTurnText: string,
  recentMessages: Array<{ role: string; content: string }>,
  userId?: string,
): Promise<HyDEResult> {
  if (!runtime) return { hypothesis: null, usage: null };

  const lastTwo = recentMessages.slice(-2).map(m => `[${m.role}] ${m.content.slice(0, 400)}`).join("\n");
  const systemPrompt = `You generate retrieval queries for a long-form roleplay campaign. Given the user's latest turn and recent context, write 2-3 sentences describing what specific characters, abilities, prior events, relationships, locations, or world-facts the assistant will need to reference for an in-character response. Use concrete proper nouns (names of people, places, objects, spells). Don't invent details — if the buffer is sparse, give a sparse hypothesis. Output the hypothesis only, no prose, no headers, no JSON.`;

  const userMessage = `<recent_messages>\n${lastTwo || "(none)"}\n</recent_messages>\n<current_user_turn>${userTurnText}</current_user_turn>`;

  try {
    let responseText = "";
    let capturedUsage: HyDEUsage | null = null;
    await runtime.streamChat({
      modelId,
      systemPrompt,
      messages: [{ role: "user", content: userMessage, attachments: [] }],
      temperature: 0.3,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: `hyde-${Date.now()}`,
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
    const trimmed = responseText.trim();
    if (!trimmed || trimmed.length < 5) return { hypothesis: null, usage: capturedUsage };
    return { hypothesis: trimmed.slice(0, 1200), usage: capturedUsage };
  } catch (err) {
    // No-silent-failures: HyDE degrading to a raw query is acceptable, but it
    // must be visible — a dead HyDE model quietly weakens retrieval otherwise.
    if (userId) {
      recordSystemEvent({
        userId,
        source: "hyde",
        message: `HyDE query expansion failed (${modelId}): ${err instanceof Error ? err.message : String(err)} — retrieval used the raw query`,
      });
    }
    return { hypothesis: null, usage: null };
  }
}
