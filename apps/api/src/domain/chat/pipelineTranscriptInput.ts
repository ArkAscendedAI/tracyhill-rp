import { createHash } from "node:crypto";
import type { MessageRepository, SettledAssistantSource } from "./messageRepository";

type MessageRow = ReturnType<MessageRepository["listForPipeline"]>[number];
export interface PipelineTranscriptManifest {
  version: 1;
  rows: Array<{ id: string; sessionId: string; hash: string }>;
  /** Preserve the original order/window when a checkpoint resumes. */
  windows: Array<{ sessionId: string; ids: string[] }>;
}

/** Shared tail of every held-input error (this class and the worker's
 *  SettledSourceChangedError): a job stopped because the transcript changed
 *  under it, canon untouched. markFailed records those as notices, not
 *  failures (2026-09-27). */
export const HELD_INPUT_MARK = "stale canon writes held";

export class PipelineInputChangedError extends Error {
  constructor(message = `an accepted transcript input changed while this job was queued or running — ${HELD_INPUT_MARK}`) {
    super(message); this.name = "PipelineInputChangedError";
  }
}

function rowHash(row: MessageRow): string {
  // Token counts, validators and updatedAt may change without changing the
  // model input. Content, scene, role and slot are part of that input.
  return createHash("sha256").update(JSON.stringify([row.id, row.sessionId, row.role, row.sortOrder, row.content, row.sceneData])).digest("hex");
}

function parseManifest(value: unknown): PipelineTranscriptManifest {
  const v = value as Partial<PipelineTranscriptManifest> | null;
  if (!v || v.version !== 1 || !Array.isArray(v.rows) || !Array.isArray(v.windows)
    || v.rows.some((r) => !r || typeof r.id !== "string" || !r.id || typeof r.sessionId !== "string" || !r.sessionId || typeof r.hash !== "string" || !/^[a-f0-9]{64}$/.test(r.hash))
    || v.windows.some((w) => !w || typeof w.sessionId !== "string" || !Array.isArray(w.ids) || w.ids.some((id) => typeof id !== "string"))) {
    throw new PipelineInputChangedError("automatic checkpoint has an invalid transcript manifest — start a fresh job");
  }
  const rows = v.rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (new Set(rows.map((r) => r.id)).size !== rows.length
    || new Set(v.windows.map((w) => w.sessionId)).size !== v.windows.length
    || v.windows.some((w) => new Set(w.ids).size !== w.ids.length || w.ids.some((id) => byId.get(id)?.sessionId !== w.sessionId))) {
    throw new PipelineInputChangedError("automatic checkpoint has inconsistent transcript identities — start a fresh job");
  }
  return { version: 1, rows: rows.map((r) => ({ ...r })), windows: v.windows.map((w) => ({ sessionId: w.sessionId, ids: [...w.ids] })) };
}

/** A run owns this object; no instance-wide mutable state is shared by jobs. */
export class PipelineTranscriptInput {
  readonly manifest: PipelineTranscriptManifest | undefined;
  constructor(private readonly messages: MessageRepository, private readonly userId: string, readonly source?: SettledAssistantSource, saved?: unknown) {
    this.manifest = source ? (saved === undefined ? { version: 1, rows: [], windows: [] } : parseManifest(saved)) : undefined;
  }

  private capture(rows: MessageRow[]): void {
    if (!this.manifest) return;
    const prior = new Map(this.manifest.rows.map((r) => [r.id, r]));
    for (const row of rows) {
      const hash = rowHash(row);
      const old = prior.get(row.id);
      if (old && (old.hash !== hash || old.sessionId !== row.sessionId)) throw new PipelineInputChangedError();
      if (!old) { const captured = { id: row.id, sessionId: row.sessionId, hash }; this.manifest.rows.push(captured); prior.set(row.id, captured); }
    }
  }

  readSession(sessionId: string): MessageRow[] {
    const live = this.messages.listForPipeline(this.userId, sessionId, this.source);
    if (!this.manifest) return live;
    const window = this.manifest.windows.find((w) => w.sessionId === sessionId);
    const byId = new Map(live.map((r) => [r.id, r]));
    const rows = window ? window.ids.map((id) => {
      const row = byId.get(id); if (!row) throw new PipelineInputChangedError(); return row;
    }) : live;
    this.capture(rows);
    if (!window) this.manifest.windows.push({ sessionId, ids: rows.map((r) => r.id) });
    return rows;
  }

  /** FTS contributes only the exact accepted rows used as evidence. */
  evidence<T extends { id: string; sessionId: string; content: string }>(hits: T[]): T[] {
    if (!this.source) return hits;
    const sessions = new Map<string, Map<string, MessageRow>>();
    return hits.filter((hit) => {
      let rows = sessions.get(hit.sessionId);
      if (!rows) { rows = new Map(this.messages.listForPipeline(this.userId, hit.sessionId, this.source).map((r) => [r.id, r])); sessions.set(hit.sessionId, rows); }
      const row = rows.get(hit.id);
      const window = this.manifest!.windows.find((w) => w.sessionId === hit.sessionId);
      if (!row || (window && !window.ids.includes(hit.id))) return false;
      if (row.content !== hit.content) throw new PipelineInputChangedError();
      this.capture([row]);
      return true;
    });
  }

  /** Must run inside the same transaction as mutations derived from these rows. */
  assertCurrent(): void {
    if (!this.source) return;
    if (!this.messages.isSettledSourceCurrent(this.userId, this.source)) throw new PipelineInputChangedError();
    const sessions = new Map<string, Map<string, MessageRow>>();
    for (const expected of this.manifest!.rows) {
      let rows = sessions.get(expected.sessionId);
      if (!rows) { rows = new Map(this.messages.listForPipeline(this.userId, expected.sessionId, this.source).map((r) => [r.id, r])); sessions.set(expected.sessionId, rows); }
      const row = rows.get(expected.id);
      if (!row || rowHash(row) !== expected.hash) throw new PipelineInputChangedError();
    }
  }
}
