// The Edit-scene form on a scene divider: its fields, the edit it sends and what it does once the save returns.

import { SCENE_EDIT_LIMITS, formatCount } from "./chatInputLimits";

export type SceneEditPayload = { location?: string; present?: string[]; presentUnaware?: string[]; reason?: string | null; date?: string | null; time?: string | null };

/** The scene as the divider shows it (the stored scene props). */
export type SceneEditScene = { location: string; present: string[]; presentUnaware: string[]; reason: string | null; date: string | null; time: string | null };

/** The form's typed text, one string per input (the name lists comma-separated). */
export type SceneEditFields = { location: string; date: string; time: string; present: string; presentUnaware: string; reason: string };

export type SceneEditResult = { ok: true } | { ok: false; error: string };

/** The fields Edit opens with: the stored scene. */
export function sceneEditFields(scene: SceneEditScene): SceneEditFields {
  return {
    location: scene.location,
    present: scene.present.join(", "),
    presentUnaware: scene.presentUnaware.join(", "),
    reason: scene.reason ?? "",
    date: scene.date ?? "",
    time: scene.time ?? "",
  };
}

/** The edit Save sends: only the fields that differ from the stored scene. */
export function sceneEditPayload(fields: SceneEditFields, scene: SceneEditScene): SceneEditPayload {
  const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    location: fields.location.trim() !== scene.location ? fields.location.trim() : undefined,
    present: fields.present !== scene.present.join(", ") ? splitList(fields.present) : undefined,
    presentUnaware: fields.presentUnaware !== scene.presentUnaware.join(", ") ? splitList(fields.presentUnaware) : undefined,
    reason: fields.reason !== (scene.reason ?? "") ? (fields.reason.trim() || null) : undefined,
    date: fields.date !== (scene.date ?? "") ? (fields.date.trim() || null) : undefined,
    time: fields.time !== (scene.time ?? "") ? (fields.time.trim() || null) : undefined,
  };
}

/**
 * What the form does once Save returns (as on Android). A saved edit closes it. A refused
 * one (a 400 on a field, a 409, a dropped connection) keeps it open with the typed fields as they are and shows the
 * message inside the form; it used to close as if saved, and reopening re-seeded every field from the stored scene.
 */
export function sceneEditAfterSave(result: SceneEditResult): { mode: "idle" | "edit"; error: string } {
  return result.ok ? { mode: "idle", error: "" } : { mode: "edit", error: result.error };
}

/**
 * What Save would send that the contract refuses, named, or null. The single-line inputs
 * carry `maxLength`; a stored value can still be longer, and the name lists are only checkable once split.
 */
export function sceneEditProblem(edit: SceneEditPayload): string | null {
  const fields = [["Location", edit.location, SCENE_EDIT_LIMITS.location], ["Date", edit.date, SCENE_EDIT_LIMITS.date], ["Time", edit.time, SCENE_EDIT_LIMITS.time], ["Reason", edit.reason, SCENE_EDIT_LIMITS.reason]] as const;
  for (const [label, value, max] of fields) {
    if (value && value.length > max) return `${label} is ${formatCount(value.length)} characters. It can be at most ${formatCount(max)}.`;
  }
  const lists = [["Present", edit.present], ["Present unaware", edit.presentUnaware]] as const;
  for (const [label, names] of lists) {
    if (!names) continue;
    if (names.length > SCENE_EDIT_LIMITS.names) return `${label} lists ${names.length} names. It can list at most ${SCENE_EDIT_LIMITS.names}.`;
    const long = names.find((name) => name.length > SCENE_EDIT_LIMITS.name);
    if (long) return `A name in ${label} is ${formatCount(long.length)} characters. A name can be at most ${formatCount(SCENE_EDIT_LIMITS.name)}.`;
  }
  return null;
}
