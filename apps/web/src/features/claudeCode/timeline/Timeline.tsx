import { useMemo, useRef } from "react";

import type { ClaudeCodeStreamState } from "../useClaudeCodeStream";
import { useScrollAnchor } from "../useScrollAnchor";
import { TaskPanel } from "./TaskPanel";
import { Markdown, StreamMarkdown } from "./Markdown";
import { QuestionCard } from "./QuestionCards";
import { AnsweredQuestionRecord, CompactMarker, ErrorTurn, FallbackNotice, ModeBanner, PlanApprovalAction, ResultTurn } from "./SpecialTurns";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolChip } from "./ToolChip";
import { mergeLive, messagesToTurns } from "./turns";
import type { AssistantBlock } from "./turns";

// ─── Assistant turn + User turn ──────────────────────────────────────────────

function AssistantTurn({ blocks, turnIndex, sessionId, userMessageId, requestedModel }: { blocks: AssistantBlock[]; turnIndex: number; sessionId?: string | null; userMessageId?: string; requestedModel?: string | null }) {
  // Serving-model transparency: badge the turn when any text block was reported
  // as produced by a different model than the one the user selected (e.g. a
  // Fable 5 safeguard substitution serving Opus 4.8).
  const servedBy = requestedModel
    ? blocks.find((b): b is AssistantBlock & { kind: "text" } =>
        b.kind === "text" && Boolean(b.model) && b.model !== requestedModel && !b.model!.startsWith(requestedModel))?.model
    : undefined;
  return (
    <div className="ccp-turn ccp-turn-assistant" data-turn={turnIndex}>
      {servedBy ? (
        <div className="ccp-served-banner" title={`Requested ${requestedModel} but this response was produced by ${servedBy}.`}>
          ⚠ Served by <strong>{servedBy}</strong> (requested {requestedModel})
        </div>
      ) : null}
      {blocks.map((b, i) => {
        if (b.kind === "thinking") return <ThinkingBlock key={i} content={b.content} live={b.live} />;
        if (b.kind === "text") return b.live ? <StreamMarkdown key={i} text={b.content} /> : <Markdown key={i} text={b.content} />;
        if (b.kind === "tool") {
          return (
            <ToolChip
              key={b.id || i}
              tool={b.tool}
              input={b.input}
              id={b.id}
              result={b.result}
              streaming={b.live}
              elapsed={b.elapsed}
              userMessageId={userMessageId}
              sessionId={sessionId}
              childBlocks={b.children}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function UserTurn({ content, turnIndex }: { content: string; turnIndex: number }) {
  return (
    <div className="ccp-turn ccp-turn-user" data-turn={turnIndex}>
      <div className="ccp-turn-user-bubble"><Markdown text={content} /></div>
    </div>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export function Timeline({ state, sessionId, onPlanResolved, requestedModel, onQuestionAnswered }: { state: ClaudeCodeStreamState; sessionId: string | null; onPlanResolved?: (approved: boolean) => void; requestedModel?: string | null; onQuestionAnswered?: () => void }) {
  const turns = useMemo(
    () => mergeLive(messagesToTurns(state.messages), state),
    [state.messages, state.streamText, state.streamThinking, state.streamTools, state.streaming],
  );
  // Find last user message uuid for revert targeting
  const lastUserMessageId = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i]!;
      if (m.type === "user" && m.uuid) return m.uuid;
    }
    return undefined;
  }, [state.messages]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { onScroll, showJump, jumpToLatest } = useScrollAnchor(scrollRef);

  const waitingForFirstContent =
    state.streaming && !state.streamText && !state.streamThinking && state.streamTools.length === 0;

  if (turns.length === 0 && !state.streaming) {
    return (
      <div className="ccp-timeline-wrap">
        <TaskPanel tasks={state.tasks} />
        <div className="ccp-timeline ccp-timeline-empty">No transcript yet. Send a prompt to start.</div>
      </div>
    );
  }

  return (
    <div className="ccp-timeline-wrap">
      <TaskPanel tasks={state.tasks} />
      <div className="ccp-timeline" ref={scrollRef} onScroll={onScroll}>
        {turns.map((turn, i) => {
          if (turn.role === "user") return <UserTurn key={i} content={turn.content} turnIndex={i} />;
          if (turn.role === "assistant") return <AssistantTurn key={i} blocks={turn.blocks} turnIndex={i} sessionId={sessionId} userMessageId={lastUserMessageId} requestedModel={requestedModel} />;
          if (turn.role === "error") return <ErrorTurn key={i} message={turn.message} />;
          if (turn.role === "system") return <div key={i} className="ccp-turn ccp-turn-system">{turn.content}</div>;
          if (turn.role === "compact") return <CompactMarker key={i} turn={turn} />;
          if (turn.role === "fallback") return <FallbackNotice key={i} category={turn.category} explanation={turn.explanation} />;
          if (turn.role === "answered") return <AnsweredQuestionRecord key={i} questions={turn.questions} />;
          if (turn.role === "result") return <ResultTurn key={i} turn={turn} />;
          return null;
        })}
        {state.modeTransitions.map((t, i) => (<ModeBanner key={`mb-${i}`} transition={t} />))}
        {state.streaming || state.connHealth === "reconnecting" || state.connHealth === "stale" ? (
          <div className="ccp-live-footer">
            {state.connHealth === "reconnecting" ? <div className="ccp-reconnecting">🔄 Reconnecting…</div> : null}
            {state.connHealth === "stale" ? <div className="ccp-reconnecting stale">⚠ Connection stale…</div> : null}
            {waitingForFirstContent && state.connHealth !== "reconnecting" && state.connHealth !== "stale" ? (
              <div className="ccp-working">⏳ Working…</div>
            ) : null}
          </div>
        ) : null}
        {state.pendingQuestion && sessionId ? (
          <QuestionCard question={state.pendingQuestion} sessionId={sessionId} onAnswered={() => onQuestionAnswered?.()} />
        ) : null}
        {state.pendingPlan && sessionId ? (
          <PlanApprovalAction sessionId={sessionId} plan={state.pendingPlan.plan} onResolved={(approved) => onPlanResolved?.(approved)} />
        ) : null}
      </div>
      {showJump ? (
        <button type="button" className="ccp-jump-latest" onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      ) : null}
    </div>
  );
}

// Re-export the turn types for consumers that previously imported from "./timeline".
export type { AssistantBlock, Turn } from "./turns";
export { messagesToTurns } from "./turns";
