import { useMutation, useMutationState, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { ScheduledBeat, WorldStatusResponse } from "@tracyhill-rp/contracts";

import { setBeatStatus } from "./worldApi";
import { Icon } from "../../shared/ui/Icon";
import { QueryError } from "../../shared/ui/QueryError";

export type BeatStatusChange = { beatId: string; status: "played" | "dismissed" };

const beatStatusKey = (campaignId: string) => ["beat-status", campaignId];

/**
 * The "mark played" / "dismiss" request: the answer is the campaign's new world status. A refusal (409: the beat
 * was already played or dismissed, from another device or by the chat) is toasted by the global mutation layer, and
 * the status is re-read so the retired beat leaves the list instead of inviting the same click again.
 */
export function beatStatusMutationOptions(queryClient: QueryClient, campaignId: string) {
  return {
    mutationKey: beatStatusKey(campaignId),
    mutationFn: ({ beatId, status }: BeatStatusChange) => setBeatStatus(campaignId, beatId, status),
    onSuccess: (data: WorldStatusResponse) => { queryClient.setQueryData(["world-status", campaignId], data); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ["world-status", campaignId] }); },
  };
}

/** The chat's world-status read, as react-query holds it. */
export type WorldStatusQuery = {
  data: WorldStatusResponse | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

/**
 * The chat's Beats popover body: the campaign's pending beats, each with "mark played" and "dismiss". A first read that
 * failed shows the failure alone with Retry, never "No pending beats."; a failed re-read keeps the last read's beats with
 * the failure above them.
 */
export function ScheduledBeatsList({ campaignId, query }: { campaignId: string; query: WorldStatusQuery }) {
  const beats: ScheduledBeat[] = query.data?.beats ?? [];
  const queryClient = useQueryClient();
  const beatStatusMutation = useMutation(beatStatusMutationOptions(queryClient, campaignId));
  // Beats with a status change in flight. Played and dismissed are terminal, so a second click on the same
  // beat before the answer lands can only be refused (409) or repeat the first; both of its buttons wait for the
  // answer, after which a retired beat leaves the list. Other beats stay clickable.
  const busyBeatIds = useMutationState({
    filters: { mutationKey: beatStatusKey(campaignId), status: "pending" },
    select: (mutation) => (mutation.state.variables as BeatStatusChange | undefined)?.beatId,
  });

  if (!query.data) {
    return query.isError
      ? <QueryError query={query} label="Unable to load the scheduled beats" />
      : <p className="muted small-copy" style={{ margin: 0 }}>Loading the scheduled beats…</p>;
  }
  return (
    <div className="cast-popover-card">
      <QueryError query={query} label="Unable to refresh the scheduled beats (showing the last read)" />
      {beats.map((b) => {
        const busy = busyBeatIds.includes(b.id);
        return (
          <div key={b.id} className={`cast-card${b.due ? "" : " is-unaware"}`}>
            <div className="cast-card-line">{b.due ? "⏰ DUE" : `⏱ due ~${b.afterInworld ?? "soon"}`}</div>
            <div className="cast-card-want">{b.description}</div>
            <div className="row gap-sm">
              <button className="ghost-button small" disabled={busy} onClick={() => beatStatusMutation.mutate({ beatId: b.id, status: "played" })}><Icon name="check" size={12} /> mark played</button>
              <button className="ghost-button small danger-text" disabled={busy} onClick={() => beatStatusMutation.mutate({ beatId: b.id, status: "dismissed" })}>dismiss</button>
            </div>
          </div>
        );
      })}
      {beats.length === 0 && <p className="muted small-copy" style={{ margin: 0 }}>No pending beats.</p>}
    </div>
  );
}
