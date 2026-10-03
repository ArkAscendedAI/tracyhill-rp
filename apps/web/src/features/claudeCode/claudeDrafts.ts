import type { ClaudeCodeFile } from "@tracyhill-rp/contracts";

export type ClaudeDraft = { input: string; files: ClaudeCodeFile[]; error: string | null; pending: number; uploads: number };
const EMPTY: ClaudeDraft = { input: "", files: [], error: null, pending: 0, uploads: 0 };

/**
 * Composer drafts for one Claude-harness backend (Claude Code or Kimi), keyed
 * by `session:<id>` or the current New slot (`newKey`). AppShell owns one
 * store per backend for the life of the authenticated shell — the same
 * contract as `CodexDraftStore` — so closing the panel (⌘⇧C / ⌘⇧X / ⌘⇧K,
 * "← RP") or switching sessions keeps every draft and its uploaded chips
 * with the session they were written for, and a send always targets that
 * session.
 *
 * `uploads` counts in-flight attachment batches from BEFORE the local file
 * read starts; `pending` counts in-flight sends. Both gate Send.
 */
export class ClaudeDraftStore {
  private drafts = new Map<string, ClaudeDraft>();
  private aliases = new Map<string, string>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  newKey = "new:0";
  // The session the panel showed when it was last closed; reopening returns
  // there (as the Codex panel does) so the draft the user left is in view.
  selectedSessionId: string | null = null;
  // ↑/↓ prompt recall (newest first, capped at 50). Shared across the
  // backend's sessions as before, but it now survives a panel close too.
  readonly history: string[] = [];

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (key: string): ClaudeDraft => this.drafts.get(this.resolve(key)) ?? EMPTY;
  private resolve(key: string): string { return this.aliases.get(key) ?? key; }
  update(key: string, update: (draft: ClaudeDraft) => ClaudeDraft) {
    const resolved = this.resolve(key);
    this.drafts.set(resolved, update(this.get(resolved)));
    for (const listener of this.listeners) listener();
  }
  /** A New-slot draft learned its real session id (the stream's `system`
   * event): move it — and anything typed since the send — under the session,
   * alias the old key so late uploads/failures still land there, and open a
   * fresh New slot. */
  attachSession(key: string, id: string) {
    const target = `session:${id}`;
    const source = this.get(key); const existing = this.get(target);
    this.drafts.set(target, { ...source, input: joinDraftText(source.input, existing.input), files: dedupeFiles([...source.files, ...existing.files]), uploads: source.uploads + existing.uploads, pending: source.pending + existing.pending, error: source.error || existing.error });
    this.drafts.delete(key);
    this.aliases.set(key, target);
    if (this.newKey === key) this.newKey = `new:${++this.sequence}`;
    for (const listener of this.listeners) listener();
  }
  /** A failed send puts the submitted text and files back without losing
   * anything typed or attached while the request was in flight. */
  restore(key: string, input: string, files: ClaudeCodeFile[], error: string) {
    this.update(key, current => ({
      ...current,
      input: joinDraftText(input, current.input),
      files: dedupeFiles([...files, ...current.files]),
      error,
    }));
  }
  pushHistory(entry: string) {
    if (!entry) return;
    this.history.unshift(entry);
    if (this.history.length > 50) this.history.length = 50;
  }
}

export function claudeDraftKey(sessionId: string | null, newKey: string) {
  return sessionId ? `session:${sessionId}` : newKey;
}

function joinDraftText(first: string, second: string) { return first && second && first !== second ? `${first}\n\n${second}` : first || second; }
function dedupeFiles(files: ClaudeCodeFile[]) { return [...new Map(files.map(file => [file.path, file])).values()]; }
