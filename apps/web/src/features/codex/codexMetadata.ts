import type { CodexSessionMetadata, CodexSessionResponse } from "@tracyhill-rp/contracts";

type Group = "settings" | "title" | "pinned";
type Mark = { revision: number; cursor?: number; source?: "ack" | "event" };
const fields: Record<Group, readonly (keyof CodexSessionMetadata)[]> = { settings: ["mode", "model", "effort", "serviceTier", "cwd"], title: ["title"], pinned: ["pinned"] };
function marks(detail: CodexSessionResponse | undefined): Partial<Record<Group, Mark>> { return (detail?.clientMetadataMarks ?? {}) as Partial<Record<Group, Mark>>; }
function mark(detail: CodexSessionResponse | undefined, group: Group): Mark { return marks(detail)[group] ?? { revision: 0 }; }
export function codexRuntimeCursor(detail: CodexSessionResponse) { return typeof detail.runtimeEventCursor === "number" ? detail.runtimeEventCursor : detail.eventCursor; }
export function codexMetadataCursor(detail: CodexSessionResponse, group: Group) { return Math.max(codexRuntimeCursor(detail), mark(detail, group).cursor ?? -1); }

/** Field ownership applies equally to a native event and an HTTP acknowledgment. */
export function applyCodexMetadata(detail: CodexSessionResponse, patch: Partial<CodexSessionMetadata>, group: Group, cursor?: number, source: "ack" | "event" = "ack"): CodexSessionResponse {
  if (cursor !== undefined && (source === "event" ? cursor <= codexMetadataCursor(detail, group) : cursor < codexMetadataCursor(detail, group))) return detail;
  const previous = mark(detail, group);
  return { ...detail, metadata: { ...detail.metadata, ...patch }, clientMetadataMarks: { ...marks(detail), [group]: { revision: previous.revision + 1, cursor, source } } };
}

/** A GET can overlap an Apply/Rename even when an older server has no ACK cursor. */
export function reconcileCodexMetadata(incoming: CodexSessionResponse, current?: CodexSessionResponse, started?: CodexSessionResponse): CodexSessionResponse {
  if (!current) return incoming;
  let metadata = incoming.metadata;
  for (const group of Object.keys(fields) as Group[]) {
    const latest = mark(current, group);
    // Pin has no native event: a successful ACK can share the old GET cursor.
    // Only an overlapping ACK owns that tie; a seeded/native event does not.
    const changedDuringRead = latest.source !== "event" && latest.revision > mark(started, group).revision && (latest.cursor === undefined || latest.cursor === codexRuntimeCursor(incoming));
    if (codexMetadataCursor(current, group) > codexRuntimeCursor(incoming) || changedDuringRead) {
      metadata = { ...metadata };
      for (const field of fields[group]) (metadata as Record<string, unknown>)[field] = current.metadata[field];
    }
  }
  return { ...incoming, metadata, clientMetadataMarks: current.clientMetadataMarks };
}

/** Matches PanelService's native settings-to-metadata mapping; absent means keep. */
export function metadataFromCodexSettings(settings: Record<string, any>): Partial<CodexSessionMetadata> {
  const sandbox = settings.sandboxPolicy ?? settings.sandbox;
  const type = typeof sandbox === "string" ? sandbox : sandbox?.type;
  const effort = Object.hasOwn(settings, "effort") ? settings.effort : settings.reasoningEffort;
  return {
    ...(sandbox !== undefined ? { mode: type === "danger-full-access" || type === "dangerFullAccess" ? "yolo" : "read-only" } : {}),
    ...(typeof settings.model === "string" ? { model: settings.model } : {}),
    ...(effort !== undefined ? { effort: typeof effort === "string" ? effort : undefined } : {}),
    ...(settings.serviceTier !== undefined ? { serviceTier: typeof settings.serviceTier === "string" ? settings.serviceTier : null } : {}),
    ...(typeof settings.cwd === "string" ? { cwd: settings.cwd } : {}),
  };
}
