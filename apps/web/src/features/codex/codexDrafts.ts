import type { CodexSessionFile } from "@tracyhill-rp/contracts";

export type CodexDraft = { input: string; files: CodexSessionFile[]; error: string | null; pending: number; uploads: number };
const EMPTY: CodexDraft = { input: "", files: [], error: null, pending: 0, uploads: 0 };

/** One store per authenticated shell; closing a panel or changing sessions keeps drafts. */
export class CodexDraftStore {
  private drafts = new Map<string, CodexDraft>();
  private aliases = new Map<string, string>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  newKey = "new:0";
  selectedSessionId: string | null = null;
  readonly questionAnswers = new Map<string, Record<string, string>>();
  readonly answeredQuestions = new Set<string>();

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (key: string): CodexDraft => this.drafts.get(this.resolve(key)) ?? EMPTY;
  private resolve(key: string): string { return this.aliases.get(key) ?? key; }
  update(key: string, update: (draft: CodexDraft) => CodexDraft) {
    const resolved = this.resolve(key);
    this.drafts.set(resolved, update(this.get(resolved)));
    for (const listener of this.listeners) listener();
  }
  attachSession(key: string, id: string) {
    const target = `session:${id}`;
    const source = this.get(key); const existing = this.get(target);
    this.drafts.set(target, { ...source, input: joinDraftText(source.input, existing.input), files: [...new Map([...source.files, ...existing.files].map(file => [file.path, file])).values()], uploads: source.uploads + existing.uploads, pending: source.pending + existing.pending, error: source.error || existing.error });
    this.drafts.delete(key);
    this.aliases.set(key, target);
    if (this.newKey === key) this.newKey = `new:${++this.sequence}`;
    for (const listener of this.listeners) listener();
  }
  restore(key: string, input: string, files: CodexSessionFile[], error: string) {
    this.update(key, current => ({
      ...current,
      input: joinDraftText(input, current.input),
      files: [...new Map([...files, ...current.files].map(file => [file.path, file])).values()],
      error,
    }));
  }
}

function joinDraftText(first: string, second: string) { return first && second && first !== second ? `${first}\n\n${second}` : first || second; }
