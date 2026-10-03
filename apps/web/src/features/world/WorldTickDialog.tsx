import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { proposedWorldEventSchema, worldTickRequestSchema } from "@tracyhill-rp/contracts";
import type { ProposedWorldEvent } from "@tracyhill-rp/contracts";

import { getWorldStatus, tickWorld, applyWorldTick } from "./worldApi";
import { reviewedEventProblems } from "./worldReview";
import { NumericInput } from "../../shared/ui/NumericInput";
import { QueryError } from "../../shared/ui/QueryError";
import { numberBounds, stringMaxLength } from "../lorebook/contractBounds";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import "../../styles/feature-world.css";

// Input caps come from the tick contract: a 130-character date
// override used to reach the server and 400 with no field named.
const TICK_FIELDS = worldTickRequestSchema.innerType().shape;
const OVERRIDE_MAX = stringMaxLength(TICK_FIELDS.fromOverride);
const GUIDANCE_MAX = stringMaxLength(TICK_FIELDS.guidance);
const SKIP_BOUNDS = numberBounds(TICK_FIELDS.skip.unwrap().shape.value);
// The review's summary and detail boxes stop at the apply contract's lengths.
const EVENT_FIELDS = proposedWorldEventSchema.shape;
const SUMMARY_MAX = stringMaxLength(EVENT_FIELDS.summary);
const DETAIL_MAX = stringMaxLength(EVENT_FIELDS.detail);

interface WorldTickDialogProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
  // The session whose Engine-panel dials (world-tick model / auto-apply) the
  // tick should honor — dials are per-session overrides.
  sessionId: string;
}

// Living World: "Advance the world". Two modes (catch up to the story /
// skip forward), live tick progress, then per-event review: veto, edit, apply.
export function WorldTickDialog({ open, onClose, campaignId, campaignName, sessionId }: WorldTickDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"catchup" | "skip">("catchup");
  const [skipValue, setSkipValue] = useState(3);
  const [skipUnit, setSkipUnit] = useState<"hours" | "days" | "weeks">("days");
  const [showOverrides, setShowOverrides] = useState(false);
  const [fromOverride, setFromOverride] = useState("");
  const [toOverride, setToOverride] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Optional GM framing for the window ("the player's character is unconscious
  // the whole time") — steers the proposal pass and binds the canon check.
  const [guidance, setGuidance] = useState("");
  // Review working set: null = mirror latest tick proposals untouched.
  const [drafts, setDrafts] = useState<{ campaignId: string; runId: string; events: Array<ProposedWorldEvent & { vetoed?: boolean }> } | null>(null);

  const statusQuery = useQuery({
    queryKey: ["world-status", campaignId],
    queryFn: () => getWorldStatus(campaignId),
    enabled: open,
    refetchInterval: (query) => {
      const s = query.state.data?.latestTick?.status;
      return s === "queued" || s === "running" ? 2000 : false;
    },
  });
  const status = statusQuery.data;
  const tick = status?.latestTick ?? null;
  const reviewable = tick?.status === "completed" && !tick.appliedAt && (tick.proposed?.length ?? 0) > 0;
  const currentDraft = drafts?.campaignId === campaignId && drafts.runId === tick?.runId ? drafts : null;
  const events = useMemo<Array<ProposedWorldEvent & { vetoed?: boolean }>>(
    () => currentDraft?.events ?? (tick?.proposed ?? []).map((e) => ({ ...e, vetoed: false })),
    [currentDraft, tick?.proposed],
  );

  const tickMutation = useMutation({
    mutationFn: (request: { campaignId: string; payload: Parameters<typeof tickWorld>[1] }) => tickWorld(request.campaignId, request.payload),
    onSuccess: (data, request) => {
      const wasUninitialized = !queryClient.getQueryData<NonNullable<typeof status>>(["world-status", request.campaignId])?.worldClock;
      queryClient.setQueryData(["world-status", request.campaignId], data);
      if (request.campaignId !== campaignId) return;
      const enqueued = data.latestTick && (data.latestTick.status === "queued" || data.latestTick.status === "running");
      setNotice(wasUninitialized && data.worldClock && !enqueued
        ? `World clock initialized to ${data.worldClock.simulatedThrough}. Nothing simulated yet — advance again once the story moves past it.`
        : "");
      setDrafts(null); setError("");
      if (enqueued) setGuidance((current) => current.trim() === (request.payload.guidance ?? "") ? "" : current);
    },
    onError: (e: Error) => setError(e.message),
  });
  const startTick = () => tickMutation.mutate({ campaignId, payload: {
      mode,
      sessionId,
      ...(mode === "skip" ? { skip: { value: skipValue, unit: skipUnit } } : {}),
      ...(fromOverride.trim() ? { fromOverride: fromOverride.trim() } : {}),
      ...(mode === "catchup" && toOverride.trim() ? { toOverride: toOverride.trim() } : {}),
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
  } });

  const applyMutation = useMutation({
    mutationFn: (request: { campaignId: string; runId: string; events: ProposedWorldEvent[] }) => applyWorldTick(request.campaignId, request.runId, request.events),
    onSuccess: (data, request) => {
      queryClient.setQueryData(["world-status", request.campaignId], data);
      queryClient.invalidateQueries({ queryKey: ["lorebook-entries"] });
      setDrafts((current) => current?.campaignId === request.campaignId && current.runId === request.runId ? null : current);
      if (request.campaignId === campaignId) setError("");
    },
    onError: (e: Error) => setError(e.message),
  });
  const applyReviewedTick = () => {
    if (!tick || !reviewable) return;
    // Apply stays disabled while an event is marked; this holds the same line for any other caller.
    if (reviewedEventProblems(events).size > 0) return;
    applyMutation.mutate({ campaignId: currentDraft?.campaignId ?? campaignId, runId: currentDraft?.runId ?? tick.runId,
      events: events.filter((event) => !event.vetoed).map(({ vetoed: _v, ...event }) => event) });
  };

  if (!open) return null;
  const busy = tick?.status === "queued" || tick?.status === "running";
  const bigGap = (status?.gapDays ?? 0) > 30;
  // Each kept event checked against the apply contract, so an emptied or over-long edit is named on its card.
  const eventProblems = reviewedEventProblems(events);
  const behindGap = (status?.gapDays ?? 0) > 0;

  function patchEvent(i: number, patch: Partial<ProposedWorldEvent & { vetoed?: boolean }>) {
    if (!tick) return;
    setDrafts({ campaignId, runId: tick.runId, events: events.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  }

  return (
    <Dialog open onClose={onClose} label="Advance the world" eyebrow="Living World" title={<>Advance the world — {campaignName}</>} icon="globe" size="lg" className="world-dialog" bodyClassName="dialog-body-stack" dismissOnBackdrop>
        <QueryError query={statusQuery} label="Unable to load world status" />
        {statusQuery.isLoading ? <p className="muted small-copy">Loading world status…</p> : null}
        {drafts && !currentDraft ? <p className="error" role="alert">The campaign or reviewed tick changed. Earlier edits are not applied to these new proposals; review this tick before applying it.</p> : null}
        {status ? <p className="muted small-copy world-clock-line">
          {status?.worldClock ? <>World simulated through <strong>{status.worldClock.simulatedThrough}</strong></> : <>World clock not initialized (first tick sets it to the story's current date)</>}
          {status?.storyNow ? <> · story is at <strong>{status.storyNow.label}</strong></> : <> · no parseable story date found</>}
          {status?.gapDays != null && status.gapDays > 0 ? <> · gap ≈ {status.gapDays} in-world day{status.gapDays === 1 ? "" : "s"}</> : null}
        </p> : null}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="muted small-copy" role="status"><Icon name="globe" size={13} /> {notice}</p>}

        {!reviewable && (
          <div className="world-tick-form">
            <div className="row gap-sm wrap-row">
              <label className={`world-mode ${mode === "catchup" ? "active" : ""}`}>
                <input type="radio" checked={mode === "catchup"} onChange={() => setMode("catchup")} />
                Catch up to the story
              </label>
              <label className={`world-mode ${mode === "skip" ? "active" : ""}`}>
                <input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} />
                Skip forward
              </label>
              {mode === "skip" && (
                <span className="row gap-xs">
                  <NumericInput aria-label="Skip amount" {...SKIP_BOUNDS} step={1} value={skipValue} onChange={(v) => setSkipValue(Math.max(1, v || 1))} style={{ width: 64 }} />
                  <select value={skipUnit} onChange={(e) => setSkipUnit(e.target.value as typeof skipUnit)}>
                    <option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option>
                  </select>
                </span>
              )}
            </div>
            <AutoTextarea
              className="world-guidance"
              minRows={2}
              maxRows={8}
              maxLength={GUIDANCE_MAX}
              placeholder="Optional GM note — what's happening during this window / why time passes (e.g. 'the player's character is unconscious the whole time' or 'the lead is away training a new skill; the rest of the cast is on their own')"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
            <button className="ghost-button small" onClick={() => setShowOverrides((o) => !o)}><Icon name={showOverrides ? "chevron-down" : "chevron-right"} size={12} /> manual date overrides</button>
            {showOverrides && (
              <div className="row gap-sm wrap-row">
                <input placeholder={mode === "skip" ? "skip from (defaults to story-now)…" : "from (in-world date)…"} value={fromOverride} maxLength={OVERRIDE_MAX} onChange={(e) => setFromOverride(e.target.value)} />
                {mode === "catchup" && <input placeholder="to (in-world date)…" value={toOverride} maxLength={OVERRIDE_MAX} onChange={(e) => setToOverride(e.target.value)} />}
              </div>
            )}
            {mode === "catchup" && bigGap && <p className="muted small-copy"><Icon name="alert" size={12} /> Large window ({status?.gapDays} days). Consider two smaller ticks, because very long windows produce arc-level mush.</p>}
            {mode === "skip" && behindGap && <p className="muted small-copy"><Icon name="alert" size={12} /> The world is {status?.gapDays} day{status?.gapDays === 1 ? "" : "s"} behind the story. Skip counts from story-now, so it jumps over that backlog without simulating it, and applying advances the clock past it for good. Run "Catch up to the story" first to cover it.</p>}
            <div className="row end">
              <span className="muted small-copy">{busy ? "Simulating offscreen events…"
                : tick?.status === "failed" ? `Last tick failed: ${tick.error ?? "unknown"}`
                : tick?.appliedAt ? `Last tick applied ${tick.appliedCount ?? 0} event(s)`
                : tick?.status === "completed" && (tick.proposed?.length ?? 0) === 0 ? `Last tick proposed no events${(tick.dropped?.length ?? 0) > 0 ? ` (${tick.dropped!.length} dropped by the canon check)` : ""}`
                : ""}</span>
              <button disabled={!status || statusQuery.isError || busy || tickMutation.isPending} onClick={startTick}>
                {busy ? "Running…" : <><Icon name="globe" size={14} /> Advance the world</>}
              </button>
            </div>
          </div>
        )}

        {reviewable && tick && (
          <div className="world-review">
            <p className="small-copy">While you were away — <strong>{events.length}</strong> proposed development{events.length === 1 ? "" : "s"} ({tick.fromInWorld ? `${tick.fromInWorld} → ` : ""}{tick.toInWorld}){(tick.dropped?.length ?? 0) > 0 ? <span className="muted"> · {tick.dropped!.length} dropped by the canon check</span> : null}:</p>
            {tick.guidance ? <p className="muted small-copy">GM note: {tick.guidance}</p> : null}
            <div className="world-events">
              {events.map((event, i) => (
                <div key={i} className={`world-event-card${event.vetoed ? " vetoed" : ""}`}>
                  <div className="row end">
                    <div className="row gap-xs wrap-row">
                      {event.actors.map((a) => <span key={a} className="world-chip"><Icon name="masks" size={12} /> {a}</span>)}
                      <span className={`world-chip vis-${event.visibility}`}>{event.visibility}</span>
                      <span className="world-chip known">known by: {event.knownBy.join(", ")}</span>
                    </div>
                    <button className={`ghost-button small${event.vetoed ? " danger-text" : ""}`} onClick={() => patchEvent(i, { vetoed: !event.vetoed })}>
                      {event.vetoed ? "vetoed — restore" : <><Icon name="x" size={12} /> veto</>}
                    </button>
                  </div>
                  <AutoTextarea className="world-event-summary" value={event.summary} disabled={event.vetoed} maxLength={SUMMARY_MAX} maxRows={4} singleLineEnter onChange={(e) => patchEvent(i, { summary: e.target.value })} />
                  <AutoTextarea className="world-event-detail" value={event.detail} disabled={event.vetoed} maxLength={DETAIL_MAX} minRows={2} maxRows={10} onChange={(e) => patchEvent(i, { detail: e.target.value })} />
                  {eventProblems.has(i) ? <p className="error small-copy" role="alert">{eventProblems.get(i)}</p> : null}
                  {event.scheduledBeat && <p className="muted small-copy">⏱ arms a beat: {event.scheduledBeat.description} (due ~{event.scheduledBeat.afterInWorld || "soon"})</p>}
                </div>
              ))}
            </div>
            <div className="row end">
              {eventProblems.size > 0
                ? <span className="error small-copy">Fix the marked event{eventProblems.size === 1 ? "" : "s"} before applying.</span>
                : <span className="muted small-copy">Applying writes {events.filter((e) => !e.vetoed).length} hidden event(s) into the lorebook (knownBy-scoped) and advances the world clock to {tick.toInWorld}.</span>}
              <button disabled={applyMutation.isPending || statusQuery.isError || eventProblems.size > 0} onClick={applyReviewedTick}>
                {applyMutation.isPending ? "Applying…" : `Apply ${events.filter((e) => !e.vetoed).length} · advance clock`}
              </button>
            </div>
          </div>
        )}
    </Dialog>
  );
}
