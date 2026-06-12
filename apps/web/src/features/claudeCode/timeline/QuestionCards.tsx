import { useState } from "react";

import { answerClaudeCodeQuestion } from "../claudeCodeApi";
import type { PendingQuestion } from "../useClaudeCodeStream";

// ─── Question card (renders pendingQuestion from stream) ─────────────────────

export function QuestionCard({ question, sessionId, onAnswered }: { question: PendingQuestion; sessionId: string; onAnswered: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSubmitting(true); setError(null);
    try {
      await answerClaudeCodeQuestion(sessionId, { questionId: question.id, answers });
      onAnswered();
    } catch (e) { setError(e instanceof Error ? e.message : "Submit failed"); }
    setSubmitting(false);
  };
  return (
    <div className="ccp-question-card">
      <div className="ccp-question-head">❓ Claude needs input</div>
      {question.questions.map((q, i) => (
        <div key={i} className="ccp-question-row">
          <div className="ccp-question-text">{q.question}</div>
          {q.options?.length ? (
            <div className="ccp-question-options">
              {q.options.map((opt, j) => (
                <button
                  key={j}
                  type="button"
                  className={`ccp-question-opt ${answers[q.question] === opt.label ? "is-sel" : ""}`}
                  onClick={() => setAnswers((c) => ({ ...c, [q.question]: opt.label }))}
                >{opt.label}</button>
              ))}
            </div>
          ) : null}
          <input
            className="ccp-question-input"
            placeholder={q.options?.length ? "Or type custom answer…" : "Your answer…"}
            value={answers[q.question] ?? ""}
            onChange={(e) => setAnswers((c) => ({ ...c, [q.question]: e.target.value }))}
          />
        </div>
      ))}
      {error ? <div className="ccp-question-error">{error}</div> : null}
      <div className="ccp-question-actions">
        <button type="button" className="ccp-question-submit" disabled={submitting || question.questions.some((q) => !answers[q.question]?.trim())} onClick={() => void submit()}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
