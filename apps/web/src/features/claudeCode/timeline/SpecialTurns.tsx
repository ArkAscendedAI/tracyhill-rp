import { useState } from "react";

import { approveClaudeCodePlan, rejectClaudeCodePlan } from "../claudeCodeApi";
import { useCodingBackend } from "../backend";
import { Markdown } from "./Markdown";
import type { AnsweredQuestion, Turn } from "./turns";
import { Icon } from "../../../shared/ui/Icon";

// (Mode transitions render through turns.ts `modeChangeNotice` as system
// notices; errors through the Transcript `role:"error"` path — neither has a
// dedicated component any more.)

// ─── Plan approval action (native ExitPlanMode round-trip) ───────────────────

export function PlanApprovalAction({ sessionId, plan, onResolved }: { sessionId: string; plan?: string | null; onResolved: (approved: boolean) => void }) {
  const { apiBase } = useCodingBackend();
  const [running, setRunning] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [showReject, setShowReject] = useState(false);
  const approve = async () => {
    setRunning("approve"); setError(null);
    try { await approveClaudeCodePlan(apiBase, sessionId); onResolved(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Approve failed"); setRunning(null); }
  };
  const reject = async () => {
    setRunning("reject"); setError(null);
    try { await rejectClaudeCodePlan(apiBase, sessionId, feedback.trim() || undefined); onResolved(false); setShowReject(false); setFeedback(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Reject failed"); setRunning(null); }
  };
  return (
    <div className="ccp-plan-approve">
      {plan ? <div className="ccp-plan-approve-body"><Markdown text={plan} /></div> : null}
      <div className="ccp-plan-approve-msg">Plan ready. Approve to switch to <strong>Full Execution</strong> and run it, or send it back for revision.</div>
      {error ? <div className="ccp-plan-approve-error">{error}</div> : null}
      {showReject ? (
        <div className="ccp-plan-reject-row">
          <input
            className="ccp-plan-reject-input"
            placeholder="What should change? (optional)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void reject(); }}
            autoFocus
          />
          <button type="button" className="ccp-plan-reject-send" disabled={running !== null} onClick={() => void reject()}>
            {running === "reject" ? "Sending…" : "Send back"}
          </button>
        </div>
      ) : null}
      <div className="ccp-plan-approve-actions">
        <button type="button" className="ccp-plan-approve-btn" disabled={running !== null} onClick={() => void approve()}>
          {running === "approve" ? "Executing…" : <><Icon name="check" size={13} /> Approve + Execute</>}
        </button>
        <button type="button" className="ccp-plan-reject-btn" disabled={running !== null} onClick={() => setShowReject((s) => !s)}>
          <Icon name="pencil" size={13} /> Revise
        </button>
      </div>
    </div>
  );
}

// ─── Compaction marker ───────────────────────────────────────────────────────

export function CompactMarker({ turn }: { turn: Extract<Turn, { role: "compact" }> }) {
  const saved = turn.preTokens && turn.postTokens ? turn.preTokens - turn.postTokens : null;
  const savedLabel = saved && saved > 0 ? ` · saved ~${(saved / 1000).toFixed(0)}k tokens` : "";
  return (
    <div className="ccp-compact-marker">
      <span><Icon name="scissors" size={12} /> conversation compacted{turn.trigger === "auto" ? " (auto)" : ""}{savedLabel}</span>
    </div>
  );
}

// ─── Answered-question record (compact historical Q→A) ───────────────────────

export function AnsweredQuestionRecord({ questions }: { questions: AnsweredQuestion[] }) {
  return (
    <div className="ccp-answered-q">
      {questions.map((q, i) => (
        <div key={i} className="ccp-answered-q-row">
          <span className="ccp-answered-q-q"><Icon name="help" size={12} /> {q.question}</span>
          <span className="ccp-answered-q-a"><Icon name="check" size={12} /> {q.answer}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Refusal card (reuses the global msg-refusal-* classes) ──────────────────

const REFUSAL_CATEGORY_LABEL: Record<string, string> = {
  cyber: "CYBER", bio: "BIO", reasoning_extraction: "REASONING", policy: "POLICY",
};

function RefusalCard({ category, explanation }: { category?: string | null; explanation?: string | null }) {
  const label = category ? (REFUSAL_CATEGORY_LABEL[category] ?? category.toUpperCase()) : null;
  return (
    <div className="msg-refusal-card">
      <div className="msg-refusal-tag">
        <span><Icon name="ban" size={12} /> Response declined</span>
        {label ? <span className="msg-refusal-category">{label}</span> : null}
      </div>
      <div className="msg-refusal-hint">
        Safety classifiers declined this request. Rephrasing may help; switching the model in the composer can also resolve false positives.
      </div>
      {explanation ? <div className="msg-refusal-explanation">{explanation}</div> : null}
    </div>
  );
}

// ─── Model fallback notice (classifier-trip downstep to a fallback model) ───
// The `model_fallback` event carries only category/explanation — never the
// model names — so the wording stays model-agnostic; the served model is
// badged on the text block itself (AssistantTurn `servedBy`).

const FALLBACK_CATEGORY_LABEL: Record<string, string> = { cyber: "cybersecurity", bio: "biology", reasoning_extraction: "reasoning-extraction" };

export function FallbackNotice({ category, explanation }: { category?: string | null; explanation?: string | null }) {
  const reason = category ? (FALLBACK_CATEGORY_LABEL[category] ?? category) : null;
  return (
    <div className="ccp-fallback-notice" title={explanation || undefined}>
      <span className="ccp-fallback-icon">⤵</span>
      <span>
        The requested model declined this turn{reason ? ` (${reason} content)` : ""} — it was served by a <strong>fallback model</strong> (see the served-by badge).
      </span>
    </div>
  );
}

export function ResultTurn({ turn }: { turn: Extract<Turn, { role: "result" }> }) {
  if (turn.stopReason === "refusal") {
    return (
      <div className="ccp-turn ccp-turn-result">
        <RefusalCard category={turn.category} explanation={turn.explanation} />
      </div>
    );
  }
  return (
    <div className="ccp-turn ccp-turn-result">
      <div className="ccp-turn-result-chip">
        {turn.sessionId ? <span className="muted">Session {turn.sessionId.slice(0, 8)}</span> : null}
        {turn.turns != null ? <span className="muted"> · {turn.turns} turn{turn.turns === 1 ? "" : "s"}</span> : null}
        {turn.duration != null ? <span className="muted"> · {(turn.duration / 1000).toFixed(1)}s</span> : null}
        {turn.cost != null ? <span className="muted"> · ${turn.cost.toFixed(4)}</span> : null}
      </div>
    </div>
  );
}
