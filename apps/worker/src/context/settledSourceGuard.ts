import type { MessageRepository, SettledAssistantSource } from "../../../api/src/domain/chat/messageRepository";
import { PipelineInputChangedError, PipelineTranscriptInput, HELD_INPUT_MARK } from "../../../api/src/domain/chat/pipelineTranscriptInput";

export function pipelineInputsForRun(messages: MessageRepository, run: { userId: string; detailsJson?: string | null }): PipelineTranscriptInput {
  const source = settledSourceForRun(run);
  const details = run.detailsJson ? JSON.parse(run.detailsJson) : {};
  if (source && details.transcriptInput === undefined && (details.checkpoint || details.neutralChecked !== undefined || details.appliedAt || details.dramatist || details.clocks)) {
    throw new PipelineInputChangedError("automatic checkpoint has no original transcript manifest — start a fresh job");
  }
  return new PipelineTranscriptInput(messages, run.userId, source, details.transcriptInput);
}

export function settledSourceForRun(run: { detailsJson?: string | null }): SettledAssistantSource | undefined {
  if (!run.detailsJson) return undefined;
  const value: unknown = (JSON.parse(run.detailsJson) as { settledSource?: unknown }).settledSource;
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") throw new Error("invalid settled source on pipeline run");
  const source = value as Partial<SettledAssistantSource>;
  if (![source.sessionId, source.messageId, source.contentHash, source.sourceUserMessageId, source.sourceUserContentHash, source.settledByMessageId].every((field) => typeof field === "string" && field.length > 0) || !Number.isInteger(source.sortOrder)) throw new Error("invalid settled source on pipeline run");
  return source as SettledAssistantSource;
}

export class SettledSourceChangedError extends Error {
  constructor() { super(`the kept reply or its opening/settling user turn changed after this job was queued — ${HELD_INPUT_MARK}`); this.name = "SettledSourceChangedError"; }
}

/** Call inside the same SQLite transaction as the worker's canon mutations. */
export function assertSettledSource(messages: MessageRepository, userId: string, source?: SettledAssistantSource): void {
  if (source && !messages.isSettledSourceCurrent(userId, source)) throw new SettledSourceChangedError();
}

/** FTS is another transcript reader: unkept tails cannot become audit evidence. */
export function settledEvidence<T extends { id: string; sessionId: string }>(messages: MessageRepository, userId: string, hits: T[], source?: SettledAssistantSource): T[] {
  if (!source) return hits;
  const allowed = new Map<string, Set<string>>();
  return hits.filter((hit) => {
    if (!allowed.has(hit.sessionId)) allowed.set(hit.sessionId, new Set(messages.listForPipeline(userId, hit.sessionId, source).map((row) => row.id)));
    return allowed.get(hit.sessionId)!.has(hit.id);
  });
}
