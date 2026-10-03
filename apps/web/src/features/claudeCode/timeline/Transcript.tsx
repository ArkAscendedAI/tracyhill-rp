import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ClaudeCodeStreamState } from "../useClaudeCodeStream";
import { useScrollAnchor } from "../useScrollAnchor";
import { Markdown, StreamMarkdown } from "./Markdown";
import { QuestionCard } from "./QuestionCards";
import { AnsweredQuestionRecord, CompactMarker, FallbackNotice, PlanApprovalAction, ResultTurn } from "./SpecialTurns";
import { ThinkingBlock } from "./ThinkingBlock";
import { Todos, isTodoTool } from "./Todos";
import { ToolChip } from "./ToolChip";
import { WorkingSpinner } from "./WorkingSpinner";
import { mergeLive, messagesToTurns } from "./turns";
import type { AssistantBlock } from "./turns";
import { Icon } from "../../../shared/ui/Icon";

// Render at most this many of the most-recent turns by default. A reopened
// session can hold thousands of turns (huge tool outputs / many subagents);
// rendering them all is what stays slow even after the server stops replaying
// deltas. Windowing bounds the DOM/render cost to the viewport; "show earlier"
// reveals more on demand. Build the FULL turn list either way — only the slice
// rendered is limited.
const WINDOW = 200;
const STEP = 300;

// ─── Assistant / user turns (single CLI scrollback) ──────────────────────────

function AssistantTurn({ blocks, turnIndex, sessionId, userMessageId, live, requestedModel }: {
  blocks: AssistantBlock[]; turnIndex: number; sessionId?: string | null; userMessageId?: string; live: boolean; requestedModel?: string | null;
}) {
  const servedBy = requestedModel
    ? blocks.find((b): b is AssistantBlock & { kind: "text" } =>
        b.kind === "text" && Boolean(b.model) && b.model !== requestedModel && !b.model!.startsWith(requestedModel))?.model
    : undefined;
  return (
    <div className="ccp-turn ccp-turn-assistant" data-turn={turnIndex}>
      {servedBy ? (
        <div className="ccp-served-note" title={`Requested ${requestedModel} but this response was produced by ${servedBy}.`}>
          <Icon name="alert" size={12} /> served by <strong>{servedBy}</strong> (requested {requestedModel})
        </div>
      ) : null}
      {blocks.map((b, i) => {
        if (b.kind === "thinking") {
          return <div key={i} className="ccp-block ccp-block-think"><ThinkingBlock content={b.content} live={b.live} /></div>;
        }
        if (b.kind === "text") {
          return (
            <div key={i} className="ccp-block ccp-block-text">
              <span className="ccp-bullet"><Icon name="dot" size={8} /></span>
              <div className="ccp-block-body">{b.live ? <StreamMarkdown text={b.content} /> : <Markdown text={b.content} />}</div>
            </div>
          );
        }
        // TodoWrite → the in-place checklist (not a raw tool dump).
        if (isTodoTool(b.tool)) {
          return (
            <div key={b.id || i} className="ccp-block ccp-block-tool">
              <span className="ccp-bullet"><Icon name="dot" size={8} /></span>
              <div className="ccp-block-body"><Todos input={b.input} /></div>
            </div>
          );
        }
        // tool (incl. Task → nested subagent activity via childBlocks)
        return (
          <div key={b.id || i} className="ccp-block ccp-block-tool">
            <span className="ccp-bullet"><Icon name="dot" size={8} /></span>
            <div className="ccp-block-body">
              <ToolChip
                tool={b.tool} input={b.input} result={b.result}
                streaming={b.live} elapsed={b.elapsed}
                userMessageId={userMessageId} sessionId={sessionId} live={live} childBlocks={b.children}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UserTurn({ content, turnIndex }: { content: string; turnIndex: number }) {
  return (
    <div className="ccp-turn ccp-turn-user" data-turn={turnIndex}>
      <span className="ccp-user-caret">&gt;</span>
      <div className="ccp-turn-user-body"><Markdown text={content} /></div>
    </div>
  );
}

export function Transcript({ state, sessionId, onPlanResolved, requestedModel, onQuestionAnswered }: {
  state: ClaudeCodeStreamState;
  sessionId: string | null;
  onPlanResolved?: (approved: boolean) => void;
  requestedModel?: string | null;
  onQuestionAnswered?: () => void;
}) {
  const turns = useMemo(
    () => mergeLive(messagesToTurns(state.messages), state),
    [state.messages, state.streamText, state.streamThinking, state.streamTools, state.streaming],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { onScroll, showJump, jumpToLatest } = useScrollAnchor(scrollRef);

  // Windowing: render only the most recent `visibleCount` turns. Reset to the
  // default whenever the session changes.
  const [visibleCount, setVisibleCount] = useState(WINDOW);
  useEffect(() => { setVisibleCount(WINDOW); }, [sessionId]);

  const start = Math.max(0, turns.length - visibleCount);
  const hidden = start;
  const visibleTurns = turns.slice(start);

  // Preserve scroll position when "show earlier" prepends turns (so the view
  // doesn't jump). The bottom-anchor hook already no-ops while the user is
  // scrolled up (which they are when the top button is reachable).
  const prependHeightRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (prependHeightRef.current != null && scrollRef.current) {
      scrollRef.current.scrollTop += scrollRef.current.scrollHeight - prependHeightRef.current;
      prependHeightRef.current = null;
    }
  }, [visibleCount]);
  const showEarlier = () => {
    if (scrollRef.current) prependHeightRef.current = scrollRef.current.scrollHeight;
    setVisibleCount((c) => Math.min(c + STEP, turns.length));
  };

  const waitingForFirstContent =
    state.streaming && !state.streamText && !state.streamThinking && state.streamTools.length === 0;
  // Background subagent tasks still running (task_started → task_notification).
  // The service may emit `result` before `done` while these run, so this strip
  // is what tells the user the turn is legitimately still open.
  const runningTasks = state.tasks.filter((t) => t.status === "running");

  return (
    <div className="ccp-transcript-wrap">
      <div className="ccp-transcript" ref={scrollRef} onScroll={onScroll}>
        {hidden > 0 ? (
          <button type="button" className="ccp-show-earlier" onClick={showEarlier}>
            ↑ Show earlier ({hidden} more {hidden === 1 ? "turn" : "turns"})
          </button>
        ) : null}
        {visibleTurns.map((turn, i) => {
          const key = start + i; // absolute index → stable across window growth
          if (turn.role === "user") return <UserTurn key={key} content={turn.content} turnIndex={key} />;
          // `streaming` is the panel's "live" state: connected to the session's
          // running query, the only time the agent can rewind files (revert.ts).
          if (turn.role === "assistant") return <AssistantTurn key={key} blocks={turn.blocks} turnIndex={key} sessionId={sessionId} userMessageId={turn.userMessageId} live={state.streaming} requestedModel={requestedModel} />;
          if (turn.role === "error") return <div key={key} className="ccp-notice ccp-notice-error">⎿ {turn.message}</div>;
          if (turn.role === "system") return <div key={key} className="ccp-notice ccp-notice-system">⎿ {turn.content}</div>;
          if (turn.role === "compact") return <CompactMarker key={key} turn={turn} />;
          if (turn.role === "fallback") return <FallbackNotice key={key} category={turn.category} explanation={turn.explanation} />;
          if (turn.role === "answered") return <AnsweredQuestionRecord key={key} questions={turn.questions} />;
          if (turn.role === "result") return <ResultTurn key={key} turn={turn} />;
          return null;
        })}

        {/* Compact background-task strip: one line per running async task.
            Completed tasks drop off here; their summary is a transcript notice. */}
        {runningTasks.length ? (
          <div className="ccp-task-strip">
            {runningTasks.map((t) => (
              <div key={t.taskId} className="ccp-notice ccp-notice-system ccp-task-item">
                <span className="ccp-live-dot" /> <Icon name="bot" size={12} /> {t.description || t.taskId}{t.subagentType ? ` · ${t.subagentType}` : ""} · running in background
              </div>
            ))}
          </div>
        ) : null}

        {/* Inline interactive cards (never banners). */}
        {state.pendingQuestion && sessionId ? (
          <QuestionCard question={state.pendingQuestion} sessionId={sessionId} onAnswered={() => onQuestionAnswered?.()} />
        ) : null}
        {state.pendingPlan && sessionId ? (
          <PlanApprovalAction sessionId={sessionId} plan={state.pendingPlan.plan} onResolved={(approved) => onPlanResolved?.(approved)} />
        ) : null}

        {/* Errors render as chronological transcript turns (turns.ts role:"error"),
            never a slot pinned here — a stale slot outlived its error and replay
            resurrected the last historical error at the bottom. */}

        {/* CLI working indicator while a turn is in flight. */}
        {state.streaming ? (
          <WorkingSpinner note={waitingForFirstContent ? "Working" : null} tokens={state.context?.totalTokens} />
        ) : null}
      </div>
      {showJump ? (
        <button type="button" className="ccp-jump-latest" onClick={jumpToLatest}>↓ Jump to latest</button>
      ) : null}
    </div>
  );
}
