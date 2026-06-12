import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPipelineQueueStatus, type PipelineQueueJob } from "./pipelineApi";

const KIND_LABELS: Record<string, string> = {
  rolling_diff: "Lorebook Sync",
  repetition_detection: "Pattern Scan",
  sysprompt_audit: "Prompt Audit",
  thread_tracker: "Thread Tracker",
  campaign_review: "Seed Update",
  wizard_v3: "Wizard",
  lorebook_consolidation: "Consolidation",
  lorebook_archival: "Archival",
};

function formatElapsed(ms: number | null): string {
  if (ms == null || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function PipelineQueuePill({ campaignId }: { campaignId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [tick, setTick] = useState(0);

  const { data } = useQuery({
    queryKey: ["pipeline-queue-status", campaignId],
    queryFn: () => getPipelineQueueStatus(campaignId),
    refetchInterval: (query) => (query.state.data?.jobs.length ? 3000 : 30000),
    enabled: !!campaignId,
  });

  const jobs = data?.jobs ?? [];
  const running = jobs.find(j => j.status === "running");

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [running?.runId]);

  if (jobs.length === 0) return null;

  const elapsed = running?.startedAt ? Date.now() - new Date(running.startedAt).getTime() : running?.elapsedMs;

  return (
    <div className="pq-pill-wrap">
      <button
        type="button"
        className="pq-pill"
        onClick={() => setExpanded(e => !e)}
        title="Pipeline queue status"
      >
        {running && <span className="pq-spinner" />}
        <span className="pq-label">
          {jobs.length === 1
            ? KIND_LABELS[jobs[0].kind] ?? jobs[0].kind
            : `${jobs.length} jobs`}
        </span>
        {elapsed != null && <span className="pq-elapsed">{formatElapsed(elapsed)}</span>}
      </button>
      {expanded && (
        <div className="pq-dropdown">
          {jobs.map(j => (
            <div key={j.runId} className="pq-job">
              <span className={`pq-dot ${j.status}`} />
              <span className="pq-job-kind">{KIND_LABELS[j.kind] ?? j.kind}</span>
              <span className="pq-job-status">
                {j.status === "running"
                  ? formatElapsed(j.startedAt ? Date.now() - new Date(j.startedAt).getTime() : j.elapsedMs)
                  : "queued"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
