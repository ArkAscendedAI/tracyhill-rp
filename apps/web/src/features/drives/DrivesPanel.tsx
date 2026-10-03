import { QueryError } from "../../shared/ui/QueryError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { driveConcealmentSchema, driveGoalSchema, driveSheetInputSchema, driveSheetSchema, driveWantSchema } from "@tracyhill-rp/contracts";
import type { DriveSheet, DriveRecord, DriveWant, DriveGoal } from "@tracyhill-rp/contracts";

import { DiffView } from "../../shared/ui/DiffView";
import { getCampaigns } from "../campaigns/campaignApi";
import { arrayElement, arrayMaxLength, describeContractIssues, recordValue, stringMaxLength } from "../lorebook/contractBounds";
import { getDrives, updateDrive, deleteDrive, getDriveHistory, revertDrive } from "./drivesApi";
import { driveFieldLabel, drivesListPreview, planDraftSync, saveDriveSheetChecked, type DriveSaveInput } from "./drivesPanelUtils";
import { createUserScopedCacheWriter } from "../auth/authCache";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import "../../styles/feature-drives.css";

interface DrivesPanelProps {
  open: boolean;
  onClose: () => void;
  initialCampaignId?: string | null;
  initialCharacter?: string | null;
}

const EMPTY_SHEET: DriveSheet = {
  wants: [], goals: [], redLines: [], leverage: [], offpageProject: null, concealment: [], dispositions: {},
};

const GOAL_STATUSES: DriveGoal["status"][] = ["active", "achieved", "abandoned", "blocked"];
const slug = () => Math.random().toString(36).slice(2, 9);

// Row caps and text caps come from the drives contract — the
// editor restated "5 / 3 / 6 / 4" and let blank rows through to the server's
// generic "invalid drive sheet". A full-sheet parse before Save names the row.
const SHEET_FIELDS = driveSheetSchema.shape;
const unbounded = Number.POSITIVE_INFINITY;
const CAPS = {
  wants: arrayMaxLength(SHEET_FIELDS.wants) ?? unbounded,
  goals: arrayMaxLength(SHEET_FIELDS.goals) ?? unbounded,
  redLines: arrayMaxLength(SHEET_FIELDS.redLines) ?? unbounded,
  leverage: arrayMaxLength(SHEET_FIELDS.leverage) ?? unbounded,
  concealment: arrayMaxLength(SHEET_FIELDS.concealment) ?? unbounded,
  // z.record carries no .max(); the cap is the refinement on
  // driveSheetInputSchema ("at most 6 dispositions") and cannot be read off it.
  dispositions: 6,
};
const TEXT_MAX = {
  want: stringMaxLength(driveWantSchema.shape.text),
  goal: stringMaxLength(driveGoalSchema.shape.text),
  redLine: stringMaxLength(arrayElement(SHEET_FIELDS.redLines)),
  leverage: stringMaxLength(arrayElement(SHEET_FIELDS.leverage)),
  offpageProject: stringMaxLength(SHEET_FIELDS.offpageProject),
  secret: stringMaxLength(driveConcealmentSchema.shape.secret),
  behavior: stringMaxLength(driveConcealmentSchema.shape.behavior),
  disposition: stringMaxLength(recordValue(SHEET_FIELDS.dispositions)),
};

// Which record the draft was seeded from — campaign AND name, since
// a same-named character in another campaign is a different sheet.
type DraftSeed = { campaignId: string | null; name: string | null; updatedAt: string | null };
const EMPTY_SEED: DraftSeed = { campaignId: null, name: null, updatedAt: null };

export function DrivesPanel({ open, onClose, initialCampaignId, initialCharacter }: DrivesPanelProps) {
  const queryClient = useQueryClient();
  const campaignsQuery = useQuery({ queryKey: ["campaigns"], queryFn: getCampaigns, enabled: open });
  const campaigns = useMemo(() => (campaignsQuery.data?.campaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    playerCharacterKeys: c.playerCharacterKeys ?? [],
  })), [campaignsQuery.data]);
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId ?? null);
  const [selected, setSelected] = useState<string | null>(initialCharacter ?? null);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState<DriveSheet>(EMPTY_SHEET);
  const [dirty, setDirty] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState("");
  // Two-step delete like every other destructive action.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [seed, setSeed] = useState<DraftSeed>(EMPTY_SEED);
  const [serverChanged, setServerChanged] = useState(false);
  // In-app unsaved-changes guard (the Lorebook panel's pattern): the action
  // that would drop the draft — close, campaign switch, another character,
  // "+ Sheet" — waits behind a confirm while the sheet is dirty.
  const [pendingNav, setPendingNav] = useState<{ run: () => void } | null>(null);

  // The panel stays mounted while closed, so its state used to outlive a
  // close: a draft edited under campaign A reappeared under the next opener's
  // campaign (the Cast popover's "Edit sheet →" on campaign B's same-named
  // character) and Save wrote it there. Every open adopts the opener's
  // campaign/character; every close resets everything.
  useEffect(() => {
    if (open) {
      setCampaignId(initialCampaignId ?? null);
      setSelected(initialCharacter ?? null);
      return;
    }
    setCampaignId(null); setSelected(null); setNewName("");
    setDraft(EMPTY_SHEET); setDirty(false); setSeed(EMPTY_SEED); setServerChanged(false);
    setShowHistory(false); setError(""); setConfirmDelete(false); setPendingNav(null);
  }, [open, initialCampaignId, initialCharacter]);
  // Opened without a campaign (sidebar footer): the first campaign. Never
  // races a deep link — that path sets its campaign in the effect above.
  useEffect(() => { if (open && !campaignId && !initialCampaignId && campaigns[0]) setCampaignId(campaigns[0].id); }, [open, campaigns, campaignId, initialCampaignId]);

  const drivesQuery = useQuery({
    queryKey: ["drives", campaignId],
    queryFn: () => getDrives(campaignId!),
    enabled: open && !!campaignId,
  });
  const drives = drivesQuery.data?.drives ?? [];
  const current: DriveRecord | undefined = useMemo(
    () => drives.find((d) => d.characterName === selected),
    [drives, selected],
  );

  // Load the selected character's sheet into the editable draft — but only
  // when the SELECTION changes or the record changed with no unsaved edits;
  // a worker rewrite landing mid-edit is surfaced, not silently adopted.
  useEffect(() => {
    const plan = planDraftSync({ seededCampaignId: seed.campaignId, seededName: seed.name, seededUpdatedAt: seed.updatedAt, campaignId, selected, record: current, dirty });
    if (plan === "none") return;
    setConfirmDelete(false);
    if (plan === "stale") { setServerChanged(true); return; }
    setServerChanged(false);
    setShowHistory(false);
    setSeed({ campaignId, name: selected, updatedAt: current?.updatedAt ?? null });
    if (plan === "new") return; // startNew() already set the empty draft + dirty
    setDraft(current?.sheet ?? EMPTY_SHEET);
    setDirty(false);
  }, [current, selected, campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  const historyQuery = useQuery({
    queryKey: ["drive-history", campaignId, selected],
    queryFn: () => getDriveHistory(campaignId!, selected!),
    enabled: open && showHistory && !!campaignId && !!selected,
  });

  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const saveMutation = useMutation({
    mutationFn: (input: DriveSaveInput) => saveDriveSheetChecked(input, {
      getDrives, updateDrive: (c, n, sheet) => updateDrive(c, n, sheet),
      adopt: (c, fresh) => { cacheUserQuery(["drives", c], fresh); },
    }),
    onSuccess: (record, input) => {
      // Held: the fresh read is in the cache and the sync effect shows the notice.
      if (!record) return;
      queryClient.invalidateQueries({ queryKey: ["drives", input.campaignId] });
      setError("");
      if (input.campaignId !== campaignId || input.characterName !== selected) return;
      // The response IS the row the refetch will carry: seed the sync from it so
      // the owner's own save is never reported as a server-side change.
      // Edits typed while the request was in flight (a newer draft object) stay
      // dirty instead of being marked saved.
      setSeed({ campaignId: input.campaignId, name: record.characterName, updatedAt: record.updatedAt });
      setServerChanged(false);
      if (input.sheet === draft) setDirty(false);
    },
    onError: (e: Error) => setError(e.message),
  });
  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteDrive(campaignId!, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["drives", campaignId] }); setSelected(null); setConfirmDelete(false); },
    onError: (e: Error) => setError(e.message),
  });
  const revertMutation = useMutation({
    mutationFn: (historyId: string) => revertDrive(campaignId!, selected!, historyId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["drives", campaignId] }); queryClient.invalidateQueries({ queryKey: ["drive-history", campaignId, selected] }); setShowHistory(false); },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  function patch(p: Partial<DriveSheet>) { setDraft((d) => ({ ...d, ...p })); setDirty(true); }
  function startNew() {
    const name = newName.trim();
    if (!name) return;
    setSelected(name); setDraft(EMPTY_SHEET); setDirty(true); setNewName("");
  }
  // Run `action` now unless the sheet has unsaved edits — then confirm first.
  const guardDirty = (action: () => void) => {
    if (dirty) { setPendingNav({ run: action }); return; }
    action();
  };
  const requestClose = () => guardDirty(onClose);
  // Save posts to the campaign + character the draft was seeded under, never
  // to whatever the dropdown shows: the two agree by the time Save is enabled
  // (the sync effect reseeds on any mismatch), so a disagreement means the
  // draft is mid-reseed and Save waits.
  const draftScope = campaignId && selected && seed.campaignId === campaignId && seed.name === selected
    ? { campaignId, characterName: selected }
    : null;
  const saveSheet = () => {
    if (!draftScope) return;
    const parsed = driveSheetInputSchema.safeParse(draft);
    if (!parsed.success) { setError(describeContractIssues(parsed.error.issues, driveFieldLabel)); return; }
    setError("");
    saveMutation.mutate({ ...draftScope, sheet: draft, seed, overwrite: serverChanged });
  };

  const names = Array.from(new Set(drives.map((d) => d.characterName))).sort();
  const isNew = selected != null && !current;
  const playerKeys = campaigns.find((campaign) => campaign.id === campaignId)?.playerCharacterKeys ?? [];
  const playerKeySet = new Set(playerKeys.map((name) => name.toLocaleLowerCase()));

  return (
    <Dialog
      open
      onClose={requestClose}
      label="Character Drives"
      eyebrow="Living World"
      title="Character Drives"
      icon="masks"
      size="wide"
      className="drives-panel"
      bodyClassName="dialog-body-flush"
      dismissOnBackdrop
      headerExtra={<select className="drives-campaign-select" value={campaignId ?? ""} onChange={(e) => { const next = e.target.value || null; guardDirty(() => { setCampaignId(next); setSelected(null); }); }}>
        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>}
    >

        {error && <p className="error" role="alert">{error}</p>}

        <div className="drives-body">
          <aside className="drives-list">
            <QueryError query={drivesQuery} label="Unable to load drive sheets" />
            {drivesQuery.isLoading ? <p className="muted small-copy">Loading drive sheets…</p> : null}
            {drivesQuery.isSuccess && names.length === 0 && <p className="muted small-copy">No drive sheets yet. Seed via the wizard, the backfill tool, or create one below.</p>}
            {names.map((name) => (
              <button key={name} className={`drives-list-row ${selected === name ? "is-selected" : ""}`} onClick={() => { if (name !== selected) guardDirty(() => setSelected(name)); }}>
                <span className="drives-list-name"><Icon name="masks" size={13} /> {name}{playerKeySet.has(name.toLocaleLowerCase()) ? " · Player (reference)" : ""}</span>
                <span className="drives-list-sub muted">{drivesListPreview(drives.find((d) => d.characterName === name)?.sheet.wants ?? [])}</span>
              </button>
            ))}
            <div className="drives-new row gap-xs">
              <input placeholder="New character name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") guardDirty(startNew); }} />
              <button className="secondary-button" onClick={() => guardDirty(startNew)} disabled={!newName.trim()}>+ Sheet</button>
            </div>
          </aside>

          <section className="drives-editor">
            {selected == null ? (
              <p className="muted">Select a character, or create a new sheet.</p>
            ) : showHistory ? (
              <DriveHistoryView
                queryError={<QueryError query={historyQuery} label="Unable to load drive history" />}
                failed={historyQuery.isError}
                loading={historyQuery.isLoading}
                entries={historyQuery.data?.entries ?? []}
                onBack={() => setShowHistory(false)}
                onRevert={(id) => revertMutation.mutate(id)}
                reverting={revertMutation.isPending}
              />
            ) : (
              <>
                <div className="row end drives-editor-head">
                  <h3>{selected}{playerKeySet.has(selected.toLocaleLowerCase()) ? <span className="muted small-copy"> · Player (reference; excluded from NPC automation)</span> : null}{isNew && <span className="muted small-copy"> · new</span>}</h3>
                  <div className="row gap-sm">
                    {!isNew && <button className="ghost-button small" onClick={() => setShowHistory(true)}>History</button>}
                    {!isNew && !confirmDelete && <button className="danger-text small" onClick={() => setConfirmDelete(true)}>Delete</button>}
                    {!isNew && confirmDelete && (
                      <>
                        <button className="danger-button small" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate(selected)} title="Deletes this sheet and its history">Confirm delete</button>
                        <button className="ghost-button small" onClick={() => setConfirmDelete(false)}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>
                {current && <p className="muted small-copy">source: {current.source}{current.lastUpdatedTurn != null ? ` · turn ${current.lastUpdatedTurn}` : ""}</p>}
                {serverChanged && current && (
                  <p className="muted small-copy" role="status">
                    This sheet changed on the server while you were editing (source: {current.source}).{" "}
                    <button className="ghost-button small" onClick={() => { setDraft(current.sheet); setDirty(false); setServerChanged(false); setSeed({ campaignId, name: selected, updatedAt: current.updatedAt }); }}>Reload it (discards your edits)</button>
                  </p>
                )}

                <WantsEditor wants={draft.wants} onChange={(wants) => patch({ wants })} />
                <GoalsEditor goals={draft.goals} onChange={(goals) => patch({ goals })} />
                <StringListEditor label="Red lines" hint="hard behavioral limits" items={draft.redLines} max={CAPS.redLines} maxLength={TEXT_MAX.redLine} onChange={(redLines) => patch({ redLines })} />
                <StringListEditor label="Leverage" hint="resources / holds they have" items={draft.leverage} max={CAPS.leverage} maxLength={TEXT_MAX.leverage} onChange={(leverage) => patch({ leverage })} />
                <div className="drives-field">
                  <label>Off-page project <span className="muted">— what they work on when absent</span></label>
                  <AutoTextarea value={draft.offpageProject ?? ""} maxLength={TEXT_MAX.offpageProject} maxRows={6} singleLineEnter onChange={(e) => patch({ offpageProject: e.target.value || null })} placeholder="e.g. quietly courting two Council votes" />
                </div>
                <ConcealmentEditor items={draft.concealment} onChange={(concealment) => patch({ concealment })} />
                <DispositionsEditor map={draft.dispositions} onChange={(dispositions) => patch({ dispositions })} />

                <div className="row end drives-save-row">
                  <span className="muted small-copy">{dirty ? "unsaved changes" : "saved"}</span>
                  <button disabled={!dirty || saveMutation.isPending || !draftScope} onClick={saveSheet}>
                    {saveMutation.isPending ? "Saving…" : "Save sheet"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        {pendingNav && (
          <Dialog
            open
            onClose={() => setPendingNav(null)}
            label="Discard unsaved sheet changes"
            eyebrow="Unsaved Changes"
            title={selected ?? "This sheet"}
            icon="alert"
            size="sm"
            zIndex={300}
            footer={<>
              <button type="button" className="secondary-button" onClick={() => setPendingNav(null)}>Keep Editing</button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const action = pendingNav.run;
                  setPendingNav(null);
                  setDraft(current?.sheet ?? EMPTY_SHEET);
                  setDirty(false);
                  setServerChanged(false);
                  action();
                }}
              >
                Discard Changes
              </button>
            </>}
          >
            <p className="muted">This drive sheet has unsaved edits. Continuing will discard them.</p>
          </Dialog>
        )}
    </Dialog>
  );
}

function WantsEditor({ wants, onChange }: { wants: DriveWant[]; onChange: (w: DriveWant[]) => void }) {
  return (
    <div className="drives-field">
      <label>Wants <span className="muted">— near-term desires (cap {CAPS.wants}); pressure escalates when ignored</span></label>
      {wants.map((w, i) => (
        <div key={w.id} className="drives-want-row row gap-xs">
          {/* `sinceTurn` is stamped by the drive_update worker: the
              turn the want was last engaged or first appeared — with pressure
              it reads as "unaddressed since turn N". */}
          <WantMarker want={w} />
          <AutoTextarea value={w.text} maxLength={TEXT_MAX.want} maxRows={6} singleLineEnter onChange={(e) => onChange(wants.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} placeholder="what they want next" />
          {w.pressure > 0 && w.sinceTurn != null && <span className="muted small-copy" style={{ whiteSpace: "nowrap" }}>since t{w.sinceTurn}</span>}
          <button className="ghost-button small" onClick={() => onChange(wants.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {wants.length < CAPS.wants && <button className="secondary-button small" onClick={() => onChange([...wants, { id: slug(), text: "", pressure: 0, sinceTurn: null }])}>+ Want</button>}
    </div>
  );
}

function GoalsEditor({ goals, onChange }: { goals: DriveGoal[]; onChange: (g: DriveGoal[]) => void }) {
  return (
    <div className="drives-field">
      <label>Goals <span className="muted">— arc-level aims (cap {CAPS.goals})</span></label>
      {goals.map((g, i) => (
        <div key={g.id} className="drives-want-row row gap-xs">
          <AutoTextarea value={g.text} maxLength={TEXT_MAX.goal} maxRows={6} singleLineEnter onChange={(e) => onChange(goals.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} placeholder="longer-term goal" />
          <select value={g.status} onChange={(e) => onChange(goals.map((x, j) => j === i ? { ...x, status: e.target.value as DriveGoal["status"] } : x))}>
            {GOAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="ghost-button small" onClick={() => onChange(goals.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {goals.length < CAPS.goals && <button className="secondary-button small" onClick={() => onChange([...goals, { id: slug(), text: "", status: "active" }])}>+ Goal</button>}
    </div>
  );
}

function StringListEditor({ label, hint, items, max, maxLength, onChange }: { label: string; hint: string; items: string[]; max: number; maxLength?: number; onChange: (v: string[]) => void }) {
  return (
    <div className="drives-field">
      <label>{label} <span className="muted">— {hint}</span></label>
      {items.map((it, i) => (
        <div key={i} className="drives-want-row row gap-xs">
          <AutoTextarea value={it} maxLength={maxLength} maxRows={6} singleLineEnter onChange={(e) => onChange(items.map((x, j) => j === i ? e.target.value : x))} />
          <button className="ghost-button small" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {items.length < max && <button className="secondary-button small" onClick={() => onChange([...items, ""])}>+ Add</button>}
    </div>
  );
}

function ConcealmentEditor({ items, onChange }: { items: { secret: string; behavior: string }[]; onChange: (v: { secret: string; behavior: string }[]) => void }) {
  return (
    <div className="drives-field">
      <label>Concealment <span className="muted">— secrets and HOW they guard them (cap {CAPS.concealment})</span></label>
      {items.map((c, i) => (
        <div key={i} className="drives-conceal row gap-xs">
          <AutoTextarea value={c.secret} maxLength={TEXT_MAX.secret} maxRows={6} singleLineEnter onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, secret: e.target.value } : x))} placeholder="the secret" />
          <AutoTextarea value={c.behavior} maxLength={TEXT_MAX.behavior} maxRows={6} singleLineEnter onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, behavior: e.target.value } : x))} placeholder="how they deflect / lie / guard it" />
          <button className="ghost-button small" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {items.length < CAPS.concealment && <button className="secondary-button small" onClick={() => onChange([...items, { secret: "", behavior: "" }])}>+ Concealment</button>}
    </div>
  );
}

function DispositionsEditor({ map, onChange }: { map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const entries = Object.entries(map);
  const [nt, setNt] = useState("");
  return (
    <div className="drives-field">
      <label>Dispositions <span className="muted">— feelings toward others, qualitative (cap {CAPS.dispositions})</span></label>
      {entries.map(([target, line]) => (
        <div key={target} className="drives-conceal row gap-xs">
          <input className="drives-disp-target" value={target} readOnly />
          <AutoTextarea value={line} maxLength={TEXT_MAX.disposition} maxRows={6} singleLineEnter onChange={(e) => onChange({ ...map, [target]: e.target.value })} placeholder="e.g. warming, but wary since the crypt" />
          <button className="ghost-button small" onClick={() => { const next = { ...map }; delete next[target]; onChange(next); }}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {entries.length < CAPS.dispositions && (
        <div className="row gap-xs">
          <input placeholder="toward whom…" value={nt} onChange={(e) => setNt(e.target.value)} />
          {/* Dedupe on the TRIMMED name — the insert uses it. */}
          <button className="secondary-button small" disabled={!nt.trim() || nt.trim() in map} onClick={() => { onChange({ ...map, [nt.trim()]: "" }); setNt(""); }}>+ Toward</button>
        </div>
      )}
    </div>
  );
}

function DriveHistoryView({ loading, entries, onBack, onRevert, reverting, queryError, failed }: {
  queryError: React.ReactNode; failed: boolean;
  loading: boolean;
  entries: Array<{ id: string; before: DriveSheet | null; after: DriveSheet; changedAtTurn: number | null; source: string; reason: string | null; createdAt: string }>;
  onBack: () => void; onRevert: (id: string) => void; reverting: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="drives-history">
      <div className="row end"><button className="ghost-button small" onClick={onBack}>← Back</button><h3>History</h3></div>
      {queryError}
      {loading && <p className="muted">Loading…</p>}
      {!loading && !failed && entries.length === 0 && <p className="muted">No history.</p>}
      {entries.map((e) => (
        <div key={e.id} className="drives-history-row">
          <button className="drives-history-head row end" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
            <span>{new Date(e.createdAt).toLocaleString()} · <span className="muted">{e.source}{e.changedAtTurn != null ? ` · turn ${e.changedAtTurn}` : ""}</span></span>
            <span className="muted small-copy">{e.reason ?? ""}</span>
          </button>
          {openId === e.id && (
            <div className="drives-history-detail">
              <DiffView oldText={JSON.stringify(e.before ?? {}, null, 2)} newText={JSON.stringify(e.after, null, 2)} />
              <button className="secondary-button small" disabled={reverting} onClick={() => onRevert(e.id)}>Revert to this</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A want row's marker: the pressure glyph, or "on hold" for a want the drive worker put on hold
 * (its object is out of the character's reach, its pressure holds instead of
 * climbing, and the agenda never renders it as something to act on now). The glyph used to show
 * an on-hold want's frozen pressure as urgency. The `blocked` flag itself
 * round-trips untouched through the editor's object spreads.
 */
export function WantMarker({ want: w }: { want: DriveWant }) {
  const title = `pressure ${w.pressure}${w.pressure > 0 && w.sinceTurn != null ? ` · unaddressed since turn ${w.sinceTurn}` : w.sinceTurn != null ? ` · since turn ${w.sinceTurn}` : ""}`;
  if (w.blocked) return <span className="drives-onhold" title={`On hold (out of reach for now) · ${title}`}>on hold</span>;
  return <span className={`drives-pressure p${Math.min(4, w.pressure)}`} title={title}>{pressureGlyph(w.pressure)}</span>;
}

function pressureGlyph(p: number): string {
  if (p >= 4) return "‼";
  if (p >= 2) return "••";
  if (p >= 1) return "·";
  return "";
}
