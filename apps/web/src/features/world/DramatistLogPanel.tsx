import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DramatistLogResponse } from "@tracyhill-rp/contracts";

import { dismissConsequence, getAdversarialState, getDramatistLog } from "./worldApi";
import { Icon } from "../../shared/ui/Icon";
import { QueryError } from "../../shared/ui/QueryError";

type Props = { campaignId: string | null; enabled: boolean };

export function DramatistLogPanel({ campaignId, enabled }: Props) {
  const log = useQuery({
    queryKey: ["dramatist-log", campaignId],
    queryFn: () => getDramatistLog(campaignId!),
    enabled: enabled && Boolean(campaignId),
    refetchInterval: enabled ? 15_000 : false,
  });

  if (!campaignId) return <div className="dramatist-empty">Select a campaign to inspect its Dramatist.</div>;
  if (log.isLoading) return <div className="dramatist-empty">Loading the curtain log…</div>;
  // A failed re-read keeps the loaded record (react-query keeps `data` beside the error), and so does this panel:
  // the failure is a line above it, and open ticks, revealed spoilers and the scroll position survive. Testing the
  // error first replaced the record on every failed 15-second refresh. Only a first read that failed has
  // nothing to show but the error.
  if (!log.data) return log.error ? <div className="lorebook-error">{log.error instanceof Error ? log.error.message : "Could not load the Dramatist log"}</div> : null;

  const data = log.data;
  return (
    <div className="dramatist-log">
      <QueryError query={log} label="Unable to refresh the Dramatist log (showing the last read)" />
      <AdversarialSection campaignId={campaignId} enabled={enabled} />
      <header className="dramatist-log-intro">
        <div>
          <h2>Behind the Curtain</h2>
          <p>Admin-only telemetry and sealed state. Hidden content stays blurred until you deliberately reveal it.</p>
        </div>
        <div className="dramatist-state-grid">
          <Metric label="Scenes since fire" value={data.state.scenesSinceFire} />
          <Metric label="Last roll" value={data.state.lastRoll ?? "—"} />
          <Metric label="Fizzle streak" value={data.state.fizzleStreak} />
          <Metric label="Cooldown" value={data.state.complicationCooldown} />
        </div>
      </header>

      <section className="dramatist-log-section">
        <h3>Tick log <span>{data.ticks.length}</span></h3>
        <div className="dramatist-ticks">
          {data.ticks.map((tick) => {
            const telemetry = tick.telemetry;
            return (
              <details className="dramatist-tick" key={tick.runId}>
                <summary>
                  <span className={`dramatist-outcome ${telemetry?.outcome ?? tick.status}`}>{telemetry?.outcome ?? tick.status}</span>
                  <strong>{telemetry ? `d100 ${telemetry.roll} → ${grantLabel(telemetry.grant)}` : "No Dramatist telemetry"}</strong>
                  <span>{formatDate(tick.requestedAt)}</span>
                  {telemetry && <span>{telemetry.inventorySize} armed</span>}
                  {tick.models?.dramatistModel && <span className="muted" title={`simulate: ${tick.models.worldTickModel ?? "—"}`}><Icon name="brain" size={12} /> {tick.models.dramatistModel}</span>}
                </summary>
                {telemetry ? (
                  <div className="dramatist-tick-detail">
                    <div className="dramatist-band-line">
                      {telemetry.bands.map((band, index) => <span key={`${band.kind}-${index}`}>{band.kind}{band.severity != null ? ` ${band.severity}` : ""}: {band.width ? `${band.min}–${band.max}` : "suppressed"}</span>)}
                    </div>
                    <p className="muted small-copy">Pressure +{telemetry.modifiers.pressureShift} · scenes {telemetry.modifiers.scenesSinceFire} · fizzles {telemetry.modifiers.fizzleStreak} · cooldown {telemetry.modifiers.complicationCooldown}{telemetry.modifiers.cooldownSuppressed ? " (complications suppressed)" : ""}</p>
                    {telemetry.selection ? (
                      <SpoilerBlock label={`${telemetry.selection.class} · severity ${telemetry.selection.severity} · ${telemetry.selection.citationInventoryId ?? "uncited texture"}`}>
                        <p>{telemetry.selection.description}</p>
                        <p className="muted small-copy">Timing: {telemetry.selection.timing} · citation: {telemetry.selection.citationType}/{telemetry.selection.citationId ?? "none"}{telemetry.selection.downgraded ? " · downgraded to telegraph" : ""}</p>
                      </SpoilerBlock>
                    ) : <p>{telemetry.reason ?? "No candidate selected."}</p>}
                    {telemetry.gates.length > 0 && (
                      <ul className="dramatist-gates">
                        {telemetry.gates.map((gate, index) => <li key={`${gate.lens}-${index}`} className={gate.ok ? "pass" : "refute"}><strong>{gate.ok ? "PASS" : "REFUTE"}</strong> {gate.lens}: {gate.reason}</li>)}
                      </ul>
                    )}
                    {telemetry.schemeAdvance && <p className="muted small-copy">Scheme advanced: {telemetry.schemeAdvance.actor}, step {telemetry.schemeAdvance.fromStep + 1} → {telemetry.schemeAdvance.toStep + 1}</p>}
                    {tick.error && <p className="danger-text">{tick.error}</p>}
                  </div>
                ) : <div className="dramatist-tick-detail muted">{tick.error ?? "This world tick predates Dramatist telemetry or ran with the feature disabled."}</div>}
              </details>
            );
          })}
          {data.ticks.length === 0 && <p className="muted small-copy">No world ticks have run for this campaign.</p>}
        </div>
      </section>

      <section className="dramatist-log-section">
        <h3>Beat lifecycle <span>{data.beats.length}</span></h3>
        <div className="dramatist-card-grid">
          {data.beats.map((beat) => (
            <article className="dramatist-beat-card" key={beat.id}>
              <div className="row gap-sm">
                <span className={`dramatist-lifecycle ${beat.lifecycle}`}>{beat.lifecycle}</span>
                <strong>{beat.class} · severity {beat.severity}</strong>
              </div>
              <SpoilerBlock label={`${beat.citationType ?? "none"}/${beat.citationId ?? "none"}`}><p>{beat.description}</p></SpoilerBlock>
              <span className="muted small-copy">{beat.timing}{beat.afterInworld ? ` · due ${beat.afterInworld}` : ""}{beat.firedMessageId ? ` · message ${beat.firedMessageId}` : ""}</span>
            </article>
          ))}
          {data.beats.length === 0 && <p className="muted small-copy">No armed or historical beats.</p>}
        </div>
      </section>

      <section className="dramatist-log-section">
        <h3>Sealed schemes <span>{data.schemes.length}</span></h3>
        <div className="dramatist-card-grid">
          {data.schemes.map((entry) => (
            <SpoilerBlock key={entry.characterName} label={`${entry.characterName} · step ${Math.min(entry.scheme.currentStep + 1, entry.scheme.steps.length)}/${entry.scheme.steps.length}`}>
              <p>Grounding: {entry.scheme.targetCitation} · cadence {entry.scheme.cadence}</p>
              {/* A dated step does not move before story-now reaches its date; Android shows it the same way. */}
              <ol>{entry.scheme.steps.map((step, index) => <li key={index} className={index < entry.scheme.currentStep ? "muted" : ""}>{step.text}{step.armsBeat ? ` — arms ${step.armsBeat.class} severity ${step.armsBeat.severity}` : ""}{step.notBefore ? ` · not before ${step.notBefore}` : ""}</li>)}</ol>
            </SpoilerBlock>
          ))}
          {data.schemes.length === 0 && <p className="muted small-copy">No sealed antagonist schemes.</p>}
        </div>
      </section>

      <section className="dramatist-log-section">
        <h3>Sealed advance notes <span>{data.sealedNotes.length}</span></h3>
        <div className="dramatist-card-grid">
          {data.sealedNotes.map((note) => <SpoilerBlock key={note.id} label={`${note.name} · ${formatDate(note.updatedAt)}`}><p>{note.content}</p></SpoilerBlock>)}
          {data.sealedNotes.length === 0 && <p className="muted small-copy">No sealed advance notes.</p>}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="dramatist-metric"><span>{label}</span><strong>{value}</strong></div>;
}

/**
 * Adversarial world state, and the ONLY window onto what its producers
 * have written. They once sat inert for two days partly because there was nowhere
 * to look: no surface listed threats, consequences or clocks, so an empty table
 * looked exactly like a working one.
 *
 * The Dismiss control is not a convenience. A consequence is authoritative and
 * self-reinforcing — it is re-injected as settled fact, so the next regenerated
 * variant is told to honour it — which means auto-recording is only safe if a
 * false positive can be removed. That reversibility is what justifies recording
 * without an approval queue.
 */
function AdversarialSection({ campaignId, enabled }: { campaignId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["adversarial-state", campaignId],
    queryFn: () => getAdversarialState(campaignId),
    enabled: enabled && Boolean(campaignId),
    refetchInterval: enabled ? 15_000 : false,
  });
  const dismiss = useMutation({
    mutationFn: (consequenceId: string) => dismissConsequence(campaignId, consequenceId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["adversarial-state", campaignId] }); },
  });
  const [pendingDismiss, setPendingDismiss] = useState<string | null>(null);

  // A failed request must not look like "no adversarial state" — that is the
  // exact blind spot this section exists to close. A failed re-read
  // keeps the last read on screen with the failure above it.
  if (!state.data) {
    if (!state.error) return null;
    return (
      <section className="dramatist-log-section">
        <h3>Adversarial world</h3>
        <div className="lorebook-error">{state.error instanceof Error ? state.error.message : "Could not load the adversarial world state"}</div>
      </section>
    );
  }
  const { worldStance, threats, consequences, clocks, standings } = state.data;
  const total = threats.length + consequences.length + clocks.length + standings.length;

  return (
    <section className="dramatist-log-section">
      <h3>Adversarial world <span>{total}</span></h3>
      <QueryError query={state} label="Unable to refresh the adversarial world (showing the last read)" />
      {worldStance < 2 ? (
        <p className="dramatist-empty">
          World stance is {worldStance}. Every producer is gated at stance 2 or above, so nothing is being
          recorded. This is the inert default, not a failure.
        </p>
      ) : total === 0 ? (
        <p className="dramatist-empty">
          Nothing recorded yet. Threats, deaths and grudges are written as they happen on the page; clocks
          arrive with the next world tick.
        </p>
      ) : null}

      {consequences.length > 0 && (
        <div className="adversarial-group">
          <h4>Established consequences <span>{consequences.length}</span></h4>
          <p className="adversarial-hint">Settled facts. These hold across regeneration. Dismiss anything the extractor got wrong.</p>
          <ul className="adversarial-list">
            {consequences.map((row) => (
              <li key={row.id}>
                <span className={`adversarial-kind kind-${row.kind}`}>{row.kind}</span>
                <strong>{row.subject}</strong>
                <span className="adversarial-detail">{row.detail}</span>
                <span className="adversarial-when">{formatDate(row.createdAt)}</span>
                {pendingDismiss === row.id ? (
                  <span className="adversarial-confirm">
                    <button type="button" onClick={() => { dismiss.mutate(row.id); setPendingDismiss(null); }}>Confirm</button>
                    <button type="button" onClick={() => setPendingDismiss(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="adversarial-dismiss" onClick={() => setPendingDismiss(row.id)}>Dismiss</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {threats.length > 0 && (
        <div className="adversarial-group">
          <h4>Armed threat fuses <span>{threats.length}</span></h4>
          <p className="adversarial-hint">Each burns down on its own source&apos;s opportunities, not on elapsed turns.</p>
          <ul className="adversarial-list">
            {threats.map((row) => (
              <li key={row.id}>
                <strong>{row.sourceCharacter}</strong>
                <span className="adversarial-detail">→ {row.target}: {row.statedAct}</span>
                <span className="adversarial-when">{row.opportunitiesRemaining} left</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {clocks.length > 0 && (
        <div className="adversarial-group">
          <h4>Offscreen clocks <span>{clocks.length}</span></h4>
          <p className="adversarial-hint">These advance on every world tick whether or not anyone engages with them. A full clock forces its beat.</p>
          <ul className="adversarial-list">
            {clocks.map((row) => (
              <li key={row.id}>
                <strong>{row.name}</strong>
                <span className="adversarial-detail">{row.impulse}</span>
                <span className="adversarial-when">{row.filled}/{row.total}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {standings.length > 0 && (
        <div className="adversarial-group">
          <h4>Standings <span>{standings.length}</span></h4>
          <p className="adversarial-hint">Grudge is written from what happens on the page; trust only moves when a want is actually satisfied.</p>
          <ul className="adversarial-list">
            {standings.map((row) => (
              <li key={row.name}>
                <strong>{row.name}</strong>
                <span className="adversarial-detail">grudge {row.grudge} · trust {row.trust}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SpoilerBlock({ label, children }: { label: string; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={`dramatist-spoiler${revealed ? " revealed" : ""}`} onClick={() => setRevealed(true)}>
      <div className="dramatist-spoiler-label">{revealed ? "REVEALED" : "CLICK TO REVEAL"} · {label}</div>
      <div className="dramatist-spoiler-content">{children}</div>
    </div>
  );
}

function grantLabel(grant: NonNullable<DramatistLogResponse["ticks"][number]["telemetry"]>["grant"]): string {
  return `${grant.kind}${grant.severity != null ? ` ${grant.severity}` : ""}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
