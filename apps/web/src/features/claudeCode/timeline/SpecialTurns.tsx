import { useState } from "react";

import { approveClaudeCodePlan, rejectClaudeCodePlan } from "../claudeCodeApi";
import type { ModeTransition, PendingPlan } from "../useClaudeCodeStream";
import { Markdown } from "./Markdown";
import type { AnsweredQuestion, Turn } from "./turns";

// ─── Mode transition banner ──────────────────────────────────────────────────

export function ModeBanner({ transition }: { transition: ModeTransition }) {
  const icon = transition.mode === "plan" || transition.mode === "research" ? "🔎"
    : transition.mode === "execute" || transition.mode === "acceptEdits" ? "⚡"
    : transition.mode === "auto" ? "🤖" : "⚙";
  const who = transition.modelInitiated ? "Claude switched to" : "Switched to";
  const label = transition.mode === "research" ? "Research & Planning" : transition.mode === "execute" ? "Full Execution" : transition.mode;
  return (
    <div className={`ccp-mode-banner ccp-mode-${transition.mode}`}>
      <span className="ccp-mode-icon">{icon}</span>
      <span className="ccp-mode-text">{who} <strong>{label}</strong>{transition.reason ? ` — ${transition.reason}` : ""}</span>
    </div>
  );
}

// ─── Plan approval action (native ExitPlanMode round-trip) ───────────────────

export function PlanApprovalAction({ sessionId, plan, onResolved }: { sessionId: string; plan?: string | null; onResolved: (approved: boolean) => void }) {
  const [running, setRunning] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [showReject, setShowReject] = useState(false);
  const approve = async () => {
    setRunning("approve"); setError(null);
    try { await approveClaudeCodePlan(sessionId); onResolved(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Approve failed"); setRunning(null); }
  };
  const reject = async () => {
    setRunning("reject"); setError(null);
    try { await rejectClaudeCodePlan(sessionId, feedback.trim() || undefined); onResolved(false); setShowReject(false); setFeedback(""); }
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
          {running === "approve" ? "Executing…" : "✓ Approve + Execute"}
        </button>
        <button type="button" className="ccp-plan-reject-btn" disabled={running !== null} onClick={() => setShowReject((s) => !s)}>
          ✎ Revise
        </button>
      </div>
    </div>
  );
}

export function ErrorTurn({ message }: { message: string }) {
  return (
    <div className="ccp-turn ccp-turn-error">
      <div className="ccp-turn-error-body">⚠ {message}</div>
    </div>
  );
}

// ─── Compaction marker ───────────────────────────────────────────────────────

export function CompactMarker({ turn }: { turn: Extract<Turn, { role: "compact" }> }) {
  const saved = turn.preTokens && turn.postTokens ? turn.preTokens - turn.postTokens : null;
  const savedLabel = saved && saved > 0 ? ` · saved ~${(saved / 1000).toFixed(0)}k tokens` : "";
  return (
    <div className="ccp-compact-marker">
      <span>✂ conversation compacted{turn.trigger === "auto" ? " (auto)" : ""}{savedLabel}</span>
    </div>
  );
}

// ─── Answered-question record (compact historical Q→A) ───────────────────────

export function AnsweredQuestionRecord({ questions }: { questions: AnsweredQuestion[] }) {
  return (
    <div className="ccp-answered-q">
      {questions.map((q, i) => (
        <div key={i} className="ccp-answered-q-row">
          <span className="ccp-answered-q-q">❓ {q.question}</span>
          <span className="ccp-answered-q-a">✓ {q.answer}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Refusal card (reuses the global msg-refusal-* classes) ──────────────────

const REFUSAL_CATEGORY_LABEL: Record<string, string> = {
  cyber: "CYBER", bio: "BIO", reasoning_extraction: "REASONING", policy: "POLICY",
};

export function RefusalCard({ category, explanation }: { category?: string | null; explanation?: string | null }) {
  const label = category ? (REFUSAL_CATEGORY_LABEL[category] ?? category.toUpperCase()) : null;
  return (
    <div className="msg-refusal-card">
      <div className="msg-refusal-tag">
        <span>⛔ Response declined</span>
        {label ? <span className="msg-refusal-category">{label}</span> : null}
      </div>
      <div className="msg-refusal-hint">
        Safety classifiers declined this request. Rephrasing may help; switching the model in the composer can also resolve false positives.
      </div>
      {explanation ? <div className="msg-refusal-explanation">{explanation}</div> : null}
    </div>
  );
}

// ─── Model fallback notice (Fable → Opus downstep on a classifier trip) ─────

const FALLBACK_CATEGORY_LABEL: Record<string, string> = { cyber: "cybersecurity", bio: "biology", reasoning_extraction: "reasoning-extraction" };

export function FallbackNotice({ category, explanation }: { category?: string | null; explanation?: string | null }) {
  const reason = category ? (FALLBACK_CATEGORY_LABEL[category] ?? category) : null;
  return (
    <div className="ccp-fallback-notice" title={explanation || undefined}>
      <span className="ccp-fallback-icon">⤵</span>
      <span>
        Fable 5 declined{reason ? ` (${reason} content)` : ""} — this turn fell back to <strong>Opus 4.8</strong>.
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
