import { Component, memo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import type { CodexPendingQuestion, CodexSessionResponse, CodexThread, CodexThreadItem } from "@tracyhill-rp/contracts";

import { useScrollAnchor } from "../claudeCode/useScrollAnchor";
import { Markdown, StreamMarkdown } from "../claudeCode/timeline/Markdown";
import { ThinkingBlock } from "../claudeCode/timeline/ThinkingBlock";
import { ExpandablePre } from "../claudeCode/timeline/ToolChip";
import { WorkingSpinner } from "../claudeCode/timeline/WorkingSpinner";
import { answerCodexQuestion } from "./codexApi";
import type { CodexEventState, CodexLiveTurn } from "./codexEvents";
import { activeCodexTurn, codexGoal, mergeCodexTurns, tailClamp } from "./codexViewState";
import type { CodexDraftStore } from "./codexDrafts";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/iconSprite";

type Props = {
  detail: CodexSessionResponse;
  live: CodexEventState;
  streamError: string | null;
  onQuestionAnswered: () => void;
  drafts?: CodexDraftStore;
};

export function CodexTranscript({ detail, live, streamError, onQuestionAnswered, drafts }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { onScroll, showJump, jumpToLatest } = useScrollAnchor(scrollRef);
  // Subagent threads are COLLAPSED by default. They render after the root turns,
  // so an expanded block put a stale subagent report (they finish mid-turn, often
  // hours before the root's final answer) at the visual bottom — where auto-scroll
  // lands — and it read as the newest reply. Collapsed, the transcript always ends
  // with the root thread's latest message; the disclosure keeps the detail one
  // click away. (Also skips rendering hundreds of items on big sessions.)
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const rootId = detail.thread.id;
  const rootLive = live.turns.filter((turn) => turn.threadId === rootId || turn.threadId === "root");
  const childLive = live.turns.filter((turn) => turn.threadId !== rootId && turn.threadId !== "root");
  const rootTurns = mergeCodexTurns(rootId, detail.thread.turns, rootLive);
  const childIds = [...new Set([...detail.descendants.map(thread => thread.id), ...childLive.map(turn => turn.threadId)])];
  const reviewIds = new Set(childIds.filter(id => detail.runtime.activeThreadId === id || mergeCodexTurns(id, detail.descendants.find(thread => thread.id === id)?.turns ?? [], childLive.filter(turn => turn.threadId === id)).some(turn => turn.items.some(item => item.type === "enteredReviewMode" || item.type === "exitedReviewMode"))));
  const subagentIds = childIds.filter(id => !reviewIds.has(id));
  const pending = live.pendingQuestions;
  const active = activeCodexTurn(detail, live) != null;
  const tokens = tokenTotal(live.tokenUsage || detail.runtime.tokenUsage);
  const goal = codexGoal(live.goal);

  return (
    <div className="ccp-transcript-wrap">
      <div ref={scrollRef} className="ccp-transcript" onScroll={onScroll}>
        {detail.turnWindow?.truncated ? (
          <div className="ccp-notice ccp-notice-system">
            <Icon name="scroll" size={13} /> {[
              // The sidecar reads only the newest 50 subagent threads: say so
              // instead of "newest 1 of 1 turns" when only threads were withheld.
              detail.turnWindow.rootReturned < detail.turnWindow.rootTotal
                ? `Showing the newest ${detail.turnWindow.rootReturned} of ${detail.turnWindow.rootTotal} turns` : null,
              detail.turnWindow.descendantThreadTotal !== undefined && detail.turnWindow.descendantThreadReturned !== undefined
                && detail.turnWindow.descendantThreadReturned < detail.turnWindow.descendantThreadTotal
                ? `${detail.turnWindow.descendantThreadReturned} of ${detail.turnWindow.descendantThreadTotal} subagent threads (newest shown)` : null,
              detail.turnWindow.descendantTotal > detail.turnWindow.descendantReturned
                ? `subagent history trimmed to ${detail.turnWindow.descendantLimit} turns each` : null,
            ].filter(Boolean).join(" · ") || "Showing a limited history window"}
            . Older history is in the session export.
          </div>
        ) : null}
        {rootTurns.map((turn) => <LiveTurnMemo key={`${turn.threadId}:${turn.id}`} turn={turn} />)}
        {goal ? <div className="ccp-notice ccp-notice-system codex-goal"><Icon name="target" size={13} /> Goal: {goal.objective}
          <div>{[goal.status, goal.tokensUsed != null ? `${goal.tokensUsed.toLocaleString()}${goal.tokenBudget != null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tokens` : null, goal.timeUsedSeconds != null ? `${goal.timeUsedSeconds}s used` : null].filter(Boolean).join(" · ")}</div>
        </div> : null}

        {[...reviewIds].map(id => <section key={id} className="codex-review"><h3>Review</h3>{mergeCodexTurns(id, detail.descendants.find(thread => thread.id === id)?.turns ?? [], childLive.filter(turn => turn.threadId === id)).map(turn => <LiveTurnMemo key={turn.id} turn={turn} />)}</section>)}
        {subagentIds.length ? (
          <section className="codex-subagents">
            <button type="button" className="codex-subagents-toggle" onClick={() => setSubagentsOpen((open) => !open)}>
              <Icon name={subagentsOpen ? "chevron-down" : "chevron-right"} size={12} /> Subagents ({subagentIds.length})
              {subagentsOpen ? null : <span className="codex-subagents-hint"> — collapsed; these finish before the reply above</span>}
            </button>
            {subagentsOpen ? (
              <>
                {detail.descendants.filter(thread => subagentIds.includes(thread.id)).map((thread) => <SubagentThread key={thread.id} thread={thread} liveTurns={childLive.filter((turn) => turn.threadId === thread.id)} />)}
                {subagentIds.filter(id => !detail.descendants.some(thread => thread.id === id)).map(id => (
                  <div key={id} className="ccp-subagent"><div className="codex-subagent-title"><Icon name="bot" size={12} /> {id.slice(0, 8)}</div>{childLive.filter(turn => turn.threadId === id).map(turn => <LiveTurnMemo key={turn.id} turn={turn} />)}</div>
                ))}
              </>
            ) : null}
          </section>
        ) : null}

        {pending.map((question) => <CodexItemBoundary key={String(question.requestId)} item={question}><CodexQuestionCard sessionId={rootId} pending={question} onAnswered={onQuestionAnswered} drafts={drafts} /></CodexItemBoundary>)}
        {live.warnings.map((warning, index) => <div key={`${warning}-${index}`} className="ccp-notice ccp-notice-system"><Icon name="alert" size={12} /> {warning}</div>)}
        {streamError ? <div className="ccp-notice ccp-notice-error">{streamError} <button type="button" onClick={onQuestionAnswered}>Refresh</button></div> : null}
        {detail.metadata.lastError ? <div className="ccp-notice ccp-notice-error">{detail.metadata.lastError}</div> : null}
        {active ? <WorkingSpinner tokens={tokens} /> : null}
      </div>
      {showJump ? <button type="button" className="ccp-jump-latest" onClick={jumpToLatest}>↓ Latest</button> : null}
    </div>
  );
}

const LiveTurnMemo = memo(LiveTurn);

function LiveTurn({ turn }: { turn: CodexLiveTurn }) {
  const live = turn.status === "inProgress";
  const currentItem = turn.items.length - 1;
  return (
    <section className="ccp-turn">
      {turn.plan ? <CodexPlan plan={turn.plan} /> : null}
      {turn.items.map((item, index) => <CodexItemBoundary key={item.id || `${turn.id}-${index}`} item={item}><CodexItemView item={item} live={live && index === currentItem && turn.itemStates?.[item.id ?? ""] !== "completed"} /></CodexItemBoundary>)}
      {turn.diff ? <CodexDiff diff={turn.diff} /> : null}
      {turn.error ? <div className="ccp-notice ccp-notice-error">{turn.error}</div> : null}
      {turn.status !== "completed" && turn.status !== "inProgress" ? <div className="ccp-turn-result-chip">{turn.status}</div> : null}
    </section>
  );
}

function SubagentThread({ thread, liveTurns }: { thread: CodexThread; liveTurns: CodexLiveTurn[] }) {
  const turns = mergeCodexTurns(thread.id, thread.turns, liveTurns);
  return (
    <div className="ccp-subagent codex-subagent-thread">
      <div className="codex-subagent-title"><Icon name="bot" size={12} /> {thread.agentNickname || thread.agentRole || thread.name || thread.id.slice(0, 8)}</div>
      {turns.map(turn => <LiveTurnMemo key={turn.id} turn={turn} />)}
    </div>
  );
}

/** One malformed wire item must cost ONE card, never the panel: without this,
 *  a render throw walks up to the app-level ErrorBoundary and takes the whole
 *  workspace down (the recurring "Something went wrong" crash — a fileChange
 *  rename item did exactly that). Mirrors the ClaudeCode panel's inline-error
 *  philosophy: degrade in place, keep the transcript alive. */
class CodexItemBoundary extends Component<{ item: CodexThreadItem | CodexPendingQuestion; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(previous: { item: CodexThreadItem | CodexPendingQuestion }) {
    if (this.state.error && previous.item !== this.props.item) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="ccp-tool-section codex-item-render-error">
          <div className="ccp-tool-section-label"><Icon name="alert" size={12} /> couldn't render this item</div>
          <pre className="codex-item-meta">{this.state.error.message}</pre>
          <NativeDetails label="Raw item" value={this.props.item} />
        </div>
      );
    }
    return this.props.children;
  }
}

/** Wire values land in JSX verbatim, and the App Server's shapes drift — a
 *  fileChange `kind` is an OBJECT ({type} for add/delete, {type, move_path}
 *  for updates and renames; fileChangeKindText labels it), which as a raw
 *  React child is minified error #31 and (behind the app-level boundary) a
 *  dead panel. Everything rendered
 *  from the wire goes through this: strings pass, known shapes format, and
 *  any unknown object degrades to compact JSON instead of a crash. */
export function wireText(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.move_path === "string") {
      const kind = typeof v.type === "string" ? v.type : "rename";
      return `${kind} → ${v.move_path}`;
    }
    try { return JSON.stringify(value); } catch { return fallback; }
  }
  return fallback;
}

/** A fileChange `kind` for its section label: the kind's type word ("add", "delete", "update"), or a
 *  rename's "update → new/path". The native kind is an object for every change (PatchChangeKind:
 *  {type:"add"}, {type:"delete"}, {type:"update", move_path}); only the rename was formatted, so every
 *  other change printed as raw JSON such as {"type":"add"}. Anything else still goes through wireText. */
export function fileChangeKindText(kind: unknown): string {
  if (kind && typeof kind === "object") {
    const v = kind as Record<string, unknown>;
    if (typeof v.type === "string" && typeof v.move_path !== "string") return v.type;
  }
  return wireText(kind, "update");
}

function CodexItemView({ item, live = false }: { item: CodexThreadItem; live?: boolean }) {
  const raw = item as Record<string, any>;
  if (item.type === "userMessage") {
    const text = (item.content || []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
    const attachments = (item.content || []).filter((part: any) => part?.type !== "text");
    return (
      <div className="ccp-turn-user">
        <span className="ccp-user-caret"><Icon name="chevron-right" size={12} /></span>
        <div className="ccp-turn-user-body">
          <Markdown text={text || "_[attachment]_"} />
          {attachments.length ? <div className="codex-item-meta">{attachments.map((part: any) => attachmentLabel(part)).filter(Boolean).join(" · ")}</div> : null}
        </div>
      </div>
    );
  }
  if (item.type === "agentMessage") return (
    <div className={`ccp-block ${live ? "is-live" : ""}`}>
      <span className="ccp-bullet"><Icon name="dot" size={8} /></span>
      <div className="ccp-block-body">{live ? <StreamMarkdown text={item.text || ""} /> : <Markdown text={item.text || ""} />}
        {Array.isArray(raw.questions) && raw.questions.length ? <div className="codex-async-questions"><strong>Reply in the composer</strong>{raw.questions.map((question: any, index: number) => <div key={index}><p>{wireText(question.title)}</p>{Array.isArray(question.options) ? <ul>{question.options.map((option: unknown, i: number) => <li key={i}>{wireText(option)}</li>)}</ul> : null}</div>)}</div> : null}
        {raw.memoryCitation ? <NativeDetails label="Memory citations" value={raw.memoryCitation} /> : null}
      </div>
    </div>
  );
  if (item.type === "reasoning") {
    const content = [...(item.summary || []), ...(Array.isArray(item.content) ? item.content.map(String) : [])].filter(Boolean).join("\n\n");
    return <div className="ccp-block-think"><ThinkingBlock content={content} live={live} /></div>;
  }
  if (item.type === "commandExecution") {
    const running = item.status === "inProgress" || item.status === "running" || (!item.status && live);
    // A build can stream tens of MB into one command — the live view keeps a
    // rolling tail so the DOM never re-paints the whole accumulation per
    // frame; the full output is in ExpandablePre once the command completes.
    const streamTail = running ? tailClamp(item.aggregatedOutput || "", 16_000) : null;
    return <CodexToolCard icon="terminal" name="Shell" label={item.command || "command"} status={item.status || (live ? "inProgress" : "completed")} elapsed={item.durationMs} autoCollapse current={live}>
    <pre className="ccp-term-prompt">$ {item.command || ""}</pre>
    {streamTail ? <pre className="ccp-term-body is-streaming">{streamTail.clamped ? `…[${streamTail.hiddenChars.toLocaleString()} earlier chars stream-trimmed — full output when the command completes]\n` : ""}{streamTail.text}<span className="ccp-term-caret">▋</span></pre> : <ExpandablePre text={item.aggregatedOutput || "[no output]"} previewLines={20} tail className="ccp-term-body" />}
    <div className="codex-item-meta">{item.cwd || ""}{item.exitCode != null ? ` · exit ${item.exitCode}` : ""}</div>
    </CodexToolCard>;
  }
  if (item.type === "fileChange") return <CodexToolCard icon="pencil" name="File changes" label={`${item.changes?.length || 0} file${item.changes?.length === 1 ? "" : "s"}`} status={item.status || (live ? "inProgress" : "completed")}>
    {(item.changes || []).map((change: any, index) => <div key={`${wireText(change?.path, "?")}-${index}`} className="ccp-tool-section"><div className="ccp-tool-section-label">{fileChangeKindText(change?.kind)} · {wireText(change?.path, "(unknown path)")}</div><ExpandablePre text={wireText(change?.diff, "[no diff]") || "[no diff]"} previewLines={24} /></div>)}
    {item.aggregatedOutput ? <div className="ccp-tool-section"><div className="ccp-tool-section-label">Output</div><ExpandablePre text={item.aggregatedOutput} previewLines={12} tail className="ccp-term-body" /></div> : null}
  </CodexToolCard>;
  if (item.type === "mcpToolCall") return <CodexToolCard icon="plug" name={`${item.server || "MCP"} · ${item.tool || "tool"}`} label={String(raw.progress || "")} status={item.status || (live ? "inProgress" : "completed")} elapsed={item.durationMs}>
    <JsonSection label="Arguments" value={item.arguments} />
    {item.result != null ? <JsonSection label="Result" value={item.result} /> : null}
    {item.error != null ? <JsonSection label="Error" value={item.error} /> : null}
  </CodexToolCard>;
  if (item.type === "dynamicToolCall") return <CodexToolCard icon="wrench" name={`${raw.namespace ? `${raw.namespace} · ` : ""}${item.tool || "tool"}`} status={raw.success === false ? "failed" : item.status || (live ? "inProgress" : "completed")} elapsed={item.durationMs}>
    <JsonSection label="Arguments" value={item.arguments} />
    {raw.contentItems != null ? <JsonSection label="Result" value={raw.contentItems} /> : null}
  </CodexToolCard>;
  if (item.type === "collabAgentToolCall") return <CodexToolCard icon="bot" name={`Agent · ${item.tool || "activity"}`} label={(item.receiverThreadIds || []).map((id) => id.slice(0, 8)).join(", ")} status={item.status || (live ? "inProgress" : "completed")}>
    {raw.prompt ? <div className="ccp-tool-section"><div className="ccp-tool-section-label">Task</div><Markdown text={String(raw.prompt)} /></div> : null}
    {raw.agentsStates ? <JsonSection label="Agents" value={raw.agentsStates} /> : null}
  </CodexToolCard>;
  if (item.type === "subAgentActivity") return <div className="ccp-notice ccp-notice-system"><Icon name="bot" size={12} /> {item.kind || "Subagent"} · {(item.agentThreadId || "").slice(0, 8)} {item.agentPath || ""}</div>;
  if (item.type === "webSearch") return <CodexToolCard icon="search" name="Web search" label={String(raw.query || "")} status={live ? "inProgress" : "completed"}>{raw.action ? <JsonSection label="Action" value={raw.action} /> : null}{raw.results ? <JsonSection label="Results" value={raw.results} /> : null}</CodexToolCard>;
  if (item.type === "plan") return <div className="codex-plan-text"><Markdown text={item.text || ""} /></div>;
  if (item.type === "contextCompaction") return <div className="ccp-compact-marker"><span><Icon name="scissors" size={12} /> Context compacted</span></div>;
  if (item.type === "imageView") return <div className="ccp-notice ccp-notice-system"><Icon name="image" size={12} /> Viewed {String(raw.path || "image")}</div>;
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return <div className="ccp-notice ccp-notice-system">{item.type === "enteredReviewMode" ? <><Icon name="search" size={12} /> Review started</> : <><Icon name="check" size={12} /> Review completed</>}{raw.review ? <Markdown text={wireText(raw.review)} /> : null}</div>;
  if (item.type === "hookPrompt") return <details className="codex-unknown-item"><summary>Hook prompt</summary><ExpandablePre text={json(raw.fragments)} /></details>;
  return <NativeDetails label={item.type} value={item} />;
}

function CodexToolCard({ icon, name, label = "", status, elapsed, autoCollapse = false, current = false, children }: { icon: IconName; name: string; label?: string; status: string; elapsed?: number | null; autoCollapse?: boolean; current?: boolean; children: React.ReactNode }) {
  const running = status === "inProgress" || status === "running";
  // Shell cards auto-open while they own the stream, then collapse when a
  // later transcript item arrives. A manual click still pins/reopens them.
  const [open, setOpen] = useState<boolean | null>(null);
  const effectiveOpen = open ?? (running || (autoCollapse && current));
  const failed = status === "failed" || status === "declined";
  return (
    <div className={`ccp-tool-chip ${effectiveOpen ? "is-open" : ""} ${failed ? "codex-tool-failed" : ""}`}>
      <button type="button" className="ccp-tool-chip-head" aria-expanded={effectiveOpen} onClick={() => setOpen(!effectiveOpen)}>
        <span className="ccp-tool-icon"><Icon name={icon} size={13} /></span><span className="ccp-tool-name">{name}</span><span className="ccp-tool-label">{label}</span><span className="ccp-tool-spacer" />
        {elapsed != null ? <span className="ccp-tool-elapsed">{(elapsed / 1000).toFixed(1)}s</span> : null}<span className={`ccp-tool-dot ${running ? "is-running" : failed ? "is-failed" : "is-done"}`} />
      </button>
      {effectiveOpen ? <div className="ccp-tool-body">{children}</div> : null}
    </div>
  );
}

function NativeDetails({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return <details className="codex-unknown-item" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open ? <ExpandablePre text={json(value)} /> : null}</details>;
}

function JsonSection({ label, value }: { label: string; value: unknown }) {
  return <div className="ccp-tool-section"><div className="ccp-tool-section-label">{label}</div><ExpandablePre text={json(value)} /></div>;
}

function CodexPlan({ plan }: { plan: CodexLiveTurn["plan"] }) {
  if (!plan) return null;
  return <div className="codex-plan"><div className="codex-plan-title">Plan</div>{plan.explanation ? <Markdown text={plan.explanation} /> : null}<ol>{plan.steps.map((step, index) => <li key={index} className={`is-${step.status || "pending"}`}><span><Icon name={planIcon(step.status)} size={12} /></span>{step.step || "Step"}</li>)}</ol></div>;
}

function CodexDiff({ diff }: { diff: string }) {
  return <details className="codex-turn-diff"><summary>Turn diff</summary><ExpandablePre text={diff} previewLines={30} /></details>;
}

function CodexQuestionCard({ sessionId, pending, onAnswered, drafts }: { sessionId: string; pending: CodexPendingQuestion; onAnswered: () => void; drafts?: CodexDraftStore }) {
  const key = `${sessionId}:${pending.requestId}`;
  const [answers, updateAnswers] = useState<Record<string, string>>(() => drafts?.questionAnswers.get(key) ?? {});
  const setAnswers = (update: (current: Record<string, string>) => Record<string, string>) => updateAnswers(current => { const next = update(current); drafts?.questionAnswers.set(key, next); return next; });
  const mutation = useMutation({
    mutationFn: () => answerCodexQuestion(sessionId, { requestId: pending.requestId, answers }),
    onSuccess: () => { drafts?.answeredQuestions.add(key); drafts?.questionAnswers.delete(key); onAnswered(); },
  });
  if (mutation.isSuccess || drafts?.answeredQuestions.has(key)) return null;
  const complete = pending.questions.every((question) => Boolean(answers[question.id]?.trim()));
  return (
    <div className="ccp-question-card">
      <div className="ccp-question-head">Codex needs your input{pending.isBlocking === false ? " · optional; the turn can continue" : ""}</div>
      {pending.questions.map((question) => (
        <div key={question.id} className="ccp-question-row">
          <div className="ccp-question-text"><strong>{question.header}</strong> · {question.question}</div>
          {question.options?.length ? <div className="ccp-question-options">{question.options.map((option) => <button type="button" key={option.label} className={`ccp-question-opt ${answers[question.id] === option.label ? "is-sel" : ""}`} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))} title={option.description}>{option.label}</button>)}</div> : null}
          {question.isOther || !question.options?.length ? <input type={question.isSecret ? "password" : "text"} className="ccp-question-input" placeholder={question.isOther ? "Or enter another answer…" : "Answer…"} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /> : null}
        </div>
      ))}
      {mutation.error ? <div className="ccp-question-error">{mutation.error.message}</div> : null}
      <div className="ccp-question-actions"><button type="button" className="ccp-question-submit" disabled={!complete || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Sending…" : "Submit"}</button></div>
    </div>
  );
}

function tokenTotal(value: Record<string, unknown> | null) {
  const total = value?.last as Record<string, unknown> | undefined;
  return typeof total?.totalTokens === "number" ? total.totalTokens : undefined;
}
function json(value: unknown) { try { return typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { return String(value); } }
function planIcon(status?: string): IconName { return status === "completed" ? "check-circle" : status === "inProgress" ? "half" : "circle"; }

function attachmentLabel(part: Record<string, unknown>): string {
  if (typeof part.name === "string") return part.name;
  if (typeof part.path === "string") return part.path;
  if (typeof part.url === "string") return part.url.startsWith("data:") ? "Attached image" : part.url;
  return typeof part.type === "string" ? part.type : "Attachment";
}
