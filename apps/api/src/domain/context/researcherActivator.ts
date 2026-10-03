import type { LorebookEntry } from "@tracyhill-rp/contracts";
import { openaiFastModeFor } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

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
  // The chat turn's abort signal (2026-09-04): a user Stop pressed during
  // context assembly ends this call at once instead of after it completes.
  signal?: AbortSignal,
  // Session dial `openaiFastModeEnabled` (2026-09-09), resolved per model.
  openaiFastMode?: boolean | null,
): Promise<ResearcherResult> {
  if (!runtime || entries.length === 0) return { entryIds: [], usage: null };
  if (signal?.aborted) return { entryIds: [], usage: null };

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
      speed: openaiFastModeFor(modelId, openaiFastMode),
      requestId: `researcher-${Date.now()}`,
      signal,
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

    // Robust parse: extract the first balanced {…} object, tolerating any
    // preamble/trailing content the model (esp. -bridge variants) emits around it
    // — the old greedy /\{[\s\S]*\}/ ran past the object and threw on trailing text.
    const parsed = parseFirstJson<{ ids?: string[] }>(responseText, "{");
    if (!parsed || !Array.isArray(parsed.ids)) {
      // No-silent-failures: BOTH unparseable and EMPTY completions are recorded.
      // The old `length > 0` gate meant a bridge hiccup that completed with zero
      // text skipped activation with no event at all.
      if (userId) {
        const empty = responseText.trim().length === 0;
        recordSystemEvent({
          userId, source: "researcher", severity: "warn",
          message: empty
            ? `researcher returned empty output (${modelId}) — activation skipped this turn`
            : `researcher returned unparseable output (${modelId}) — activation skipped this turn`,
          details: { responseLen: responseText.length, head: responseText.slice(0, 200), tail: responseText.slice(-160) },
        });
      }
      return { entryIds: [], usage: capturedUsage };
    }
    const validIds = new Set(entries.map(e => e.id));
    return { entryIds: parsed.ids.filter(id => typeof id === "string" && validIds.has(id)).slice(0, maxPicks), usage: capturedUsage };
  } catch (err) {
    // A user Stop mid-assembly aborts this call through the turn's signal —
    // not a researcher failure, nothing to record.
    if (signal?.aborted) return { entryIds: [], usage: null };
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
