import type { LorebookEntry } from "@tracyhill-rp/contracts";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { recordSystemEvent } from "../system/systemEvents";

export interface ResearcherUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ResearcherResult {
  entryIds: string[];
  usage: ResearcherUsage | null;
}

export async function runResearcherActivation(
  runtime: ChatRuntime | null,
  modelId: string,
  entries: LorebookEntry[],
  userTurnText: string,
  alreadyActivated: Set<string>,
  maxPicks = 12,
  userId?: string,
): Promise<ResearcherResult> {
  if (!runtime || entries.length === 0) return { entryIds: [], usage: null };

  const available = entries
    .filter(e => !alreadyActivated.has(e.id) && e.isEnabled && !e.isConstant)
    .map(e => {
      const keys = Array.isArray(e.keys) && e.keys.length > 0 ? ` | keys=${e.keys.join(",")}` : "";
      const excerpt = (e.content || "").slice(0, 140).replace(/\s+/g, " ").trim();
      const excerptStr = excerpt ? ` | excerpt="${excerpt}${(e.content || "").length > 140 ? "..." : ""}"` : "";
      return `- id=${e.id} | name=${e.name}${e.tag ? ` | tag=${e.tag}` : ""}${keys}${excerptStr}`;
    })
    .join("\n");

  if (!available) return { entryIds: [], usage: null };

  const systemPrompt = `You are a librarian. Given the user's last turn and a list of available lorebook entries (with titles, tags, keys, and short content excerpts), return up to ${maxPicks} entry IDs whose content is likely needed for the assistant's reply. Use the excerpts to judge actual relevance — don't rely on titles alone, since a vague title may hide highly-relevant content and vice versa. Output JSON only: {"ids": ["...", "..."]}. Do not include entries that are already activated.`;

  const userMessage = `<last_user_turn>${userTurnText}</last_user_turn>\n<available_entries>\n${available}\n</available_entries>`;

  try {
    let responseText = "";
    let capturedUsage: ResearcherUsage | null = null;
    await runtime.streamChat({
      modelId,
      systemPrompt,
      messages: [{ role: "user", content: userMessage, attachments: [] }],
      temperature: 0,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: `researcher-${Date.now()}`,
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

    const match = responseText.match(/\{[\s\S]*"ids"[\s\S]*\}/);
    if (!match) return { entryIds: [], usage: capturedUsage };
    const parsed = JSON.parse(match[0]) as { ids: string[] };
    if (!Array.isArray(parsed.ids)) return { entryIds: [], usage: capturedUsage };
    const validIds = new Set(entries.map(e => e.id));
    return { entryIds: parsed.ids.filter(id => typeof id === "string" && validIds.has(id)).slice(0, maxPicks), usage: capturedUsage };
  } catch (err) {
    // No-silent-failures: a dead researcher quietly weakens retrieval — record it.
    if (userId) {
      recordSystemEvent({
        userId,
        source: "researcher",
        message: `researcher activation failed (${modelId}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return { entryIds: [], usage: null };
  }
}
