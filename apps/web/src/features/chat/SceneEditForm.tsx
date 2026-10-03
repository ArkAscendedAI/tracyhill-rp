import { SCENE_EDIT_LIMITS } from "./chatInputLimits";
import type { SceneEditFields } from "./sceneEdit";

type Props = {
  fields: SceneEditFields;
  onField: (key: keyof SceneEditFields, value: string) => void;
  /** The last refused save's message, shown inside the form; empty when there is none. */
  error: string;
  /** What Save would send that the contract refuses (`sceneEditProblem`): shown instead, and Save waits. */
  problem?: string | null;
  /** The save is running. */
  submitting: boolean;
  /** The chat is busy elsewhere (a send or another message change). */
  disabled: boolean;
  onCancel: () => void;
  onSave: () => void;
};

/** The Edit-scene form inside a scene divider. */
export function SceneEditForm({ fields, onField, error, problem, submitting, disabled, onCancel, onSave }: Props) {
  const busy = submitting || disabled;
  const message = problem || error;
  return (
    <div className="scene-divider-edit">
      <div className="scene-divider-edit-head"><strong>Edit scene metadata</strong></div>
      <label className="scene-divider-edit-row"><span className="lbl">Location</span><input type="text" maxLength={SCENE_EDIT_LIMITS.location} value={fields.location} onChange={(e) => onField("location", e.target.value)} disabled={busy} /></label>
      <label className="scene-divider-edit-row"><span className="lbl">Date</span><input type="text" maxLength={SCENE_EDIT_LIMITS.date} value={fields.date} onChange={(e) => onField("date", e.target.value)} placeholder="e.g. Monday, September 28, 1998" disabled={busy} /></label>
      <label className="scene-divider-edit-row"><span className="lbl">Time</span><input type="text" maxLength={SCENE_EDIT_LIMITS.time} value={fields.time} onChange={(e) => onField("time", e.target.value)} placeholder="e.g. 10:47 AM, late evening" disabled={busy} /></label>
      <label className="scene-divider-edit-row"><span className="lbl">Present (comma-separated)</span><input type="text" value={fields.present} onChange={(e) => onField("present", e.target.value)} disabled={busy} /></label>
      <label className="scene-divider-edit-row"><span className="lbl">Present unaware (comma-separated)</span><input type="text" value={fields.presentUnaware} onChange={(e) => onField("presentUnaware", e.target.value)} disabled={busy} /></label>
      <label className="scene-divider-edit-row"><span className="lbl">Reason</span><input type="text" maxLength={SCENE_EDIT_LIMITS.reason} value={fields.reason} onChange={(e) => onField("reason", e.target.value)} placeholder="What changed (optional)" disabled={busy} /></label>
      {message ? <p className="error small-copy" role="alert">{message}</p> : null}
      <div className="scene-divider-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" onClick={onSave} disabled={busy || Boolean(problem)}>{submitting ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
