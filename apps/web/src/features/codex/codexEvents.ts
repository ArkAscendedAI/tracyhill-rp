import type { CodexPendingQuestion, CodexStreamEvent, CodexThreadItem } from "@tracyhill-rp/contracts";
import { codexPendingQuestionSchema } from "@tracyhill-rp/contracts";

export type CodexLiveTurn = {
  id: string;
  threadId: string;
  status: string;
  items: CodexThreadItem[];
  error: string | null;
  diff: string;
  plan: { explanation?: string | null; steps: Array<{ step?: string; status?: string }> } | null;
  itemStates?: Record<string, "partial" | "started" | "completed">;
  statusKnown?: boolean;
};

export type CodexEventState = {
  turns: CodexLiveTurn[];
  warnings: string[];
  tokenUsage: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  // Latest `thread/goal/updated` payload (cumulative snapshot; seeded from
  // runtime.goal when the panel opens mid-turn).
  goal: Record<string, unknown> | null;
  pendingQuestions: CodexPendingQuestion[];
  lastEventIdx: number;
  // undefined until a snapshot/lifecycle event establishes the root state.
  activeTurnId?: string | null;
};

export const EMPTY_CODEX_EVENT_STATE: CodexEventState = { turns: [], warnings: [], tokenUsage: null, settings: null, goal: null, pendingQuestions: [], lastEventIdx: -1 };

/**
 * Incremental event reducer. apply() folds a batch into mutable internal state
 * in O(batch); snapshot() exports a React-safe view that re-materializes ONLY
 * the turns touched since the previous snapshot, so memoized transcript rows
 * keep their identity. The previous shape — a whole-array re-sort + re-reduce
 * inside a useMemo — was O(total events) on every rAF flush, which turned
 * long streaming sessions into per-frame jank.
 *
 * apply() requires idx to be monotonic across batches (the hook's cursor guard
 * provides this); a stray lower idx is skipped rather than corrupting
 * accumulated delta state.
 */
export class CodexEventReducer {
  constructor(private readonly rootThreadId?: string) {}
  private turns = new Map<string, CodexLiveTurn>();
  private order: string[] = [];
  private warnings: string[] = [];
  private pendingFromEvents = new Map<string, CodexPendingQuestion>();
  private tokenUsage: Record<string, unknown> | null = null;
  private settings: Record<string, unknown> | null = null;
  private goal: Record<string, unknown> | null = null;
  private lastEventIdx = -1;
  private dirtyTurns = new Set<string>();
  private exportedTurns = new Map<string, CodexLiveTurn>();
  private warningsSnapshot: string[] = [];
  private warningsDirty = false;
  private activeTurnId: string | null | undefined;
  private activeThreadId: string | undefined;
  private completedTurns = new Set<string>();
  private runtimeEventCursor = -1;
  private settingsEventCursor = -1;
  private hydratedPlanKey: string | null = null;
  private hydratedDiffKey: string | null = null;

  apply(events: CodexStreamEvent[]): void {
    for (const event of [...events].sort((a, b) => a.idx - b.idx)) {
      if (event.idx <= this.lastEventIdx) continue;
      this.lastEventIdx = event.idx;
      this.applyOne(event);
    }
  }

  snapshot(): CodexEventState {
    for (const key of this.dirtyTurns) {
      const turn = this.turns.get(key);
      if (!turn) continue;
      // Items are mutated in place by the delta branches, so dirty turns are
      // re-materialized (turn + item objects); untouched turns keep identity.
      this.exportedTurns.set(key, { ...turn, itemStates: { ...turn.itemStates }, items: turn.items.map((item) => ({ ...item })) });
    }
    this.dirtyTurns.clear();
    if (this.warningsDirty) {
      this.warningsSnapshot = [...this.warnings];
      this.warningsDirty = false;
    }
    const pending = new Map<string, CodexPendingQuestion>();
    for (const [id, question] of this.pendingFromEvents) pending.set(id, question);
    return {
      turns: this.order.flatMap((key) => { const turn = this.exportedTurns.get(key); return turn ? [turn] : []; }),
      warnings: this.warningsSnapshot,
      tokenUsage: this.tokenUsage,
      settings: this.settings,
      goal: this.goal,
      pendingQuestions: [...pending.values()],
      lastEventIdx: this.lastEventIdx,
      activeTurnId: this.activeTurnId,
    };
  }

  private getTurn(threadId: string, turnId: string): CodexLiveTurn {
    const key = `${threadId}:${turnId}`;
    let turn = this.turns.get(key);
    if (!turn) {
      turn = { id: turnId, threadId, status: "inProgress", statusKnown: false, itemStates: {}, items: [], error: null, diff: "", plan: null };
      this.turns.set(key, turn);
      this.order.push(key);
    }
    this.dirtyTurns.add(key);
    return turn;
  }

  // Panel opened mid-turn: interim diff snapshots are live-stream-only, so
  // the current diff arrives via runtime.turnDiff instead of the event seed.
  seedTurnDiff(threadId: string, turnId: string, diff: string): void {
    if (!diff) return;
    this.getTurn(threadId, turnId).diff = diff;
    this.hydratedDiffKey = `${threadId}:${turnId}`;
  }

  seedWarning(message: string): void {
    this.addWarning(message);
  }

  seedGoal(goal: Record<string, unknown> | null | undefined): void {
    this.goal = goal ?? null;
  }

  isTurnCompleted(threadId: string, turnId: string): boolean { return this.completedTurns.has(`${threadId}:${turnId}`); }

  seedRuntime(runtime: { activeTurnId: string | null; activeThreadId?: unknown; tokenUsage: Record<string, unknown> | null; settings: Record<string, unknown> | null; plan: (NonNullable<CodexLiveTurn["plan"]> & { threadId?: string | null; turnId?: string | null }) | null; pendingQuestions?: CodexPendingQuestion[] }, runtimeEventCursor = -1): void {
    this.runtimeEventCursor = runtimeEventCursor;
    this.settingsEventCursor = runtimeEventCursor;
    this.pendingFromEvents = new Map((runtime.pendingQuestions ?? []).map(question => [String(question.requestId), question]));
    this.activeTurnId = runtime.activeTurnId;
    this.activeThreadId = typeof runtime.activeThreadId === "string" ? runtime.activeThreadId : this.rootThreadId;
    this.tokenUsage = runtime.tokenUsage;
    this.settings = runtime.settings;
    if (runtime.plan) {
      // Completed plans retain explicit ownership. Legacy ownerless snapshots
      // describe the root; never attach one to a detached review child.
      const threadId = runtime.plan.threadId || (this.activeThreadId === this.rootThreadId ? this.rootThreadId : undefined);
      const turnId = runtime.plan.turnId || (threadId === this.activeThreadId ? runtime.activeTurnId : undefined);
      if (threadId && turnId) {
        this.getTurn(threadId, turnId).plan = runtime.plan;
        this.hydratedPlanKey = `${threadId}:${turnId}`;
      }
    }
  }

  seedSettings(settings: Record<string, unknown>, cursor: number): void { this.settings = settings; this.settingsEventCursor = cursor; }

  private applyOne(event: CodexStreamEvent): void {
    const params = event.params as Record<string, any>;
    if (params?.stub === true) return; // sidecar stub lines are replay-internal; never render one

    const threadId = String(params.threadId || params.thread?.id || "root");
    const turnId = String(params.turnId || params.turn?.id || "live");
    const updateRuntime = event.idx > this.runtimeEventCursor;
    const isRoot = !this.rootThreadId || threadId === this.rootThreadId || threadId === "root";
    if (event.method === "turn/started") {
      const turn = this.getTurn(threadId, turnId);
      turn.status = params.turn?.status || "inProgress";
      turn.statusKnown = true;
      if (updateRuntime && (isRoot || threadId === this.activeThreadId)) { this.activeTurnId = turnId; this.activeThreadId = threadId; }
      for (const item of params.turn?.items || []) upsertItem(turn, item, "started");
    } else if (event.method === "item/started" || event.method === "item/completed") {
      if (params.item) upsertItem(this.getTurn(threadId, turnId), params.item, event.method === "item/completed" ? "completed" : "started");
    } else if (event.method === "item/agentMessage/delta") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "agentMessage");
      item.text = String(item.text || "") + String(params.delta || "");
    } else if (event.method === "item/reasoning/summaryPartAdded") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "reasoning");
      const summary = [...(item.summary || [])];
      while (summary.length <= Number(params.summaryIndex || 0)) summary.push("");
      item.summary = summary;
    } else if (event.method === "item/reasoning/summaryTextDelta") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "reasoning");
      const summary = [...(item.summary || [])];
      const index = Number(params.summaryIndex || 0);
      while (summary.length <= index) summary.push("");
      summary[index] = String(summary[index] || "") + String(params.delta || "");
      item.summary = summary;
    } else if (event.method === "item/reasoning/textDelta") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "reasoning");
      const content = Array.isArray(item.content) ? [...item.content] : [];
      const index = Number(params.contentIndex || 0);
      while (content.length <= index) content.push("");
      content[index] = String(content[index] || "") + String(params.delta || "");
      item.content = content;
    } else if (event.method === "item/commandExecution/outputDelta") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "commandExecution");
      item.aggregatedOutput = String(item.aggregatedOutput || "") + String(params.delta || "");
      item.status = "inProgress";
    } else if (event.method === "item/plan/delta") {
      // Live delta streams the sidecar forwards but the reducer dropped: a plan
      // item's text and a file change's apply-output were silently stale until
      // item/completed.
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "plan");
      item.text = String(item.text || "") + String(params.delta || "");
    } else if (event.method === "item/fileChange/outputDelta") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "fileChange");
      item.aggregatedOutput = String(item.aggregatedOutput || "") + String(params.delta || "");
      item.status = "inProgress";
    } else if (event.method === "item/mcpToolCall/progress") {
      const item = ensureItem(this.getTurn(threadId, turnId), params.itemId, "mcpToolCall");
      (item as Record<string, unknown>).progress = params.message;
    } else if (event.method === "turn/diff/updated") {
      if (updateRuntime || this.hydratedDiffKey !== `${threadId}:${turnId}`) this.getTurn(threadId, turnId).diff = String(params.diff || "");
    } else if (event.method === "turn/plan/updated") {
      if (updateRuntime || this.hydratedPlanKey !== `${threadId}:${turnId}`) this.getTurn(threadId, turnId).plan = { explanation: params.explanation, steps: params.plan || [] };
    } else if (event.method === "turn/completed") {
      const turn = this.getTurn(threadId, turnId);
      turn.status = params.turn?.status || "completed";
      turn.statusKnown = true;
      turn.error = params.turn?.error?.message || null;
      this.completedTurns.add(`${threadId}:${turnId}`);
      if (updateRuntime) for (const [id, question] of this.pendingFromEvents) if (question.threadId === threadId && question.turnId === turnId) this.pendingFromEvents.delete(id);
      if (updateRuntime && (isRoot || threadId === this.activeThreadId) && (this.activeTurnId === undefined || this.activeTurnId === turnId)) this.activeTurnId = null;
      for (const item of params.turn?.items || []) upsertItem(turn, item, "completed");
    } else if (event.method === "thread/tokenUsage/updated" && isRoot && updateRuntime) this.tokenUsage = params.tokenUsage || null;
    else if (event.method === "thread/settings/updated" && isRoot && event.idx > this.settingsEventCursor) this.settings = params.threadSettings || null;
    else if (event.method === "thread/goal/updated" && isRoot && updateRuntime) this.goal = params;
    else if (event.method === "thread/goal/cleared" && isRoot && updateRuntime) this.goal = null;
    else if (event.method === "item/tool/requestUserInput" && updateRuntime) {
      // The snapshot path validates pendingQuestions with the contract schema;
      // the live path stored the raw params, so a CLI drift (`questions`
      // missing/null) threw in render outside any boundary. A
      // question that cannot be read is a visible warning, never a crash.
      const parsed = codexPendingQuestionSchema.safeParse(params);
      if (parsed.success) this.pendingFromEvents.set(String(parsed.data.requestId), parsed.data);
      else this.addWarning(`A Codex question (request ${String(params.requestId ?? "?")}) could not be read from the stream; answer it from the CLI or refresh the session.`);
    } else if (updateRuntime && (event.method === "item/tool/requestUserInput/resolved" || event.method === "serverRequest/resolved")) {
      if (params.requestId !== undefined) {
        const id = String(params.requestId);
        this.pendingFromEvents.delete(id);
      }
    } else if (event.method === "warning" || event.method === "configWarning" || event.method === "bridge/restarted" || event.method === "bridge/approvalAutoDeclined") {
      this.addWarning(String(params.message || params.summary || event.method));
    } else if (event.method === "model/rerouted") {
      this.addWarning(`Model rerouted: ${params.fromModel || "requested"} → ${params.toModel || "fallback"}`);
    } else if (event.method === "error") {
      this.addWarning(`${params.willRetry ? "Retrying" : "Error"}${isRoot ? "" : ` · agent ${threadId.slice(0, 8)}`}: ${params.error?.message || "Codex request failed"}`);
    }
  }

  private addWarning(message: string): void {
    if (!message || this.warnings.includes(message)) return;
    this.warnings.push(message);
    this.warningsDirty = true;
  }
}

function ensureItem(turn: CodexLiveTurn, itemId: unknown, type: string) {
  const id = String(itemId || `${type}-${turn.items.length}`);
  let item = turn.items.find((entry) => entry.id === id);
  if (!item) {
    item = { id, type };
    turn.items.push(item);
    (turn.itemStates ??= {})[id] = "partial";
  }
  return item;
}

function upsertItem(turn: CodexLiveTurn, item: CodexThreadItem, state: "started" | "completed") {
  const index = turn.items.findIndex((entry) => entry.id && entry.id === item.id);
  if (index >= 0) turn.items[index] = { ...turn.items[index], ...item };
  else turn.items.push({ ...item });
  if (item.id) (turn.itemStates ??= {})[item.id] = state;
}
