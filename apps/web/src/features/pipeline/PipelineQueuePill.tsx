import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getPipelineQueueStatus } from "./pipelineApi";
import { formatElapsed, formatPipelineKind } from "./pipelineUtils";

// Elapsed readouts use the ONE formatter (pipelineUtils.formatElapsed, h:mm:ss
// past an hour); the pill's own m:ss copy printed "125:33" for a two-hour
// audit the drawer showed as "2:05:33".

export function PipelineQueuePill({ campaignId }: { campaignId: string }) {
  const [expanded, setExpanded] = useState(false);
  // Re-render trigger only — the elapsed readout is recomputed from Date.now().
  const [, setTick] = useState(0);

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
            ? formatPipelineKind(jobs[0].kind)
            : `${jobs.length} jobs`}
        </span>
        {elapsed != null && <span className="pq-elapsed">{formatElapsed(elapsed)}</span>}
      </button>
      {expanded && (
        <div className="pq-dropdown">
          {jobs.map(j => (
            <div key={j.runId} className="pq-job">
              <span className={`pq-dot ${j.status}`} />
              <span className="pq-job-kind">{formatPipelineKind(j.kind)}</span>
              <span className="pq-job-status">
                {j.status === "running"
                  ? formatElapsed(j.startedAt ? Date.now() - new Date(j.startedAt).getTime() : (j.elapsedMs ?? 0))
                  : "queued"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
