import type {
  CodexAnswerRequest,
  CodexDoctorResponse,
  CodexFileSearchResponse,
  CodexForkRequest,
  CodexForkResponse,
  CodexMcpResponse,
  CodexPatchRequest,
  CodexReviewRequest,
  CodexSendRequest,
  CodexSendResponse,
  CodexSessionMetadata,
  CodexSessionResponse,
  CodexSessionsResponse,
  CodexSettingsRequest,
  CodexSettingsResponse,
  CodexShellRequest,
  CodexSkillsResponse,
  CodexStatusResponse,
  CodexSteerRequest,
  CodexStreamEvent,
  CodexUploadRequest,
  CodexUploadResponse,
} from "@tracyhill-rp/contracts";
import { codexStreamEventSchema } from "@tracyhill-rp/contracts";

import { apiFetch, apiFetchResponse } from "../../shared/api/client";

const base = "/api/codex";

export function getCodexStatus() { return apiFetch<CodexStatusResponse>(`${base}/status`, { method: "GET" }); }
export function getCodexSessions() { return apiFetch<CodexSessionsResponse>(`${base}/sessions`, { method: "GET" }); }
export function getCodexSession(sessionId: string, signal?: AbortSignal) { return apiFetch<CodexSessionResponse>(`${base}/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", signal }); }
export function uploadCodexFile(payload: CodexUploadRequest) {
  return apiFetch<CodexUploadResponse>(`${base}/upload`, { method: "POST", body: JSON.stringify(payload) });
}
export function sendCodexTurn(payload: CodexSendRequest) {
  return apiFetch<CodexSendResponse>(`${base}/sessions`, { method: "POST", body: JSON.stringify(payload) });
}
export function steerCodexTurn(sessionId: string, payload: CodexSteerRequest) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/steer`, { method: "POST", body: JSON.stringify(payload) });
}
export function updateCodexSettings(sessionId: string, payload: CodexSettingsRequest) {
  return apiFetch<CodexSettingsResponse>(`${base}/sessions/${encodeURIComponent(sessionId)}/settings`, { method: "POST", body: JSON.stringify(payload) });
}
export function patchCodexSession(sessionId: string, payload: CodexPatchRequest) {
  return apiFetch<CodexSessionMetadata>(`${base}/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: JSON.stringify(payload) });
}
export function interruptCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
}
export function deleteCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
export function compactCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST" });
}
export function forkCodexSession(sessionId: string, payload: CodexForkRequest = {}) {
  return apiFetch<CodexForkResponse>(`${base}/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: JSON.stringify(payload) });
}
export function reviewCodexSession(sessionId: string, payload: CodexReviewRequest = {}) {
  return apiFetch<CodexSendResponse & { activeThreadId?: string }>(`${base}/sessions/${encodeURIComponent(sessionId)}/review`, { method: "POST", body: JSON.stringify(payload) });
}
export function runCodexShell(sessionId: string, payload: CodexShellRequest) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/shell`, { method: "POST", body: JSON.stringify(payload) });
}
export function answerCodexQuestion(sessionId: string, payload: CodexAnswerRequest) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/answer`, { method: "POST", body: JSON.stringify(payload) });
}
export function archiveCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
}
export function unarchiveCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`${base}/sessions/${encodeURIComponent(sessionId)}/unarchive`, { method: "POST" });
}
export function searchCodexFiles(workspaceId: string, query: string) {
  return apiFetch<CodexFileSearchResponse>(`${base}/fs/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`, { method: "GET" });
}
export function getCodexSkills(sessionId?: string) {
  return apiFetch<CodexSkillsResponse>(`${base}/skills${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "GET" });
}
export function getCodexMcp(sessionId?: string) {
  return apiFetch<CodexMcpResponse>(`${base}/mcp${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "GET" });
}
export function getCodexDoctor(sessionId?: string) {
  return apiFetch<CodexDoctorResponse>(`${base}/doctor${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "GET" });
}
export async function downloadCodexExport(sessionId: string) {
  const response = await apiFetchResponse(`${base}/sessions/${encodeURIComponent(sessionId)}/export`);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  // The RP API's own export name, and Android's.
  anchor.download = `codex-${sessionId.slice(0, 8)}.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function streamCodexEvents(sessionId: string, after: number, onEvent: (event: CodexStreamEvent) => void, signal: AbortSignal, onConnected?: () => void, onProtocolError?: (message: string) => void) {
  const response = await apiFetchResponse(`${base}/sessions/${encodeURIComponent(sessionId)}/stream?after=${after}`, { signal });
  if (!response.body) throw new Error("Codex stream unavailable");
  onConnected?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try { while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = findBoundary(buffer);
    while (boundary) {
      const chunk = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseCodexSseChunk(chunk, onProtocolError);
      if (parsed) onEvent(parsed);
      boundary = findBoundary(buffer);
    }
    if (done) break;
  } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function parseCodexSseChunk(chunk: string, onProtocolError?: (message: string) => void): CodexStreamEvent | null {
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  if (!data.length) return null;
  try {
    const raw: unknown = JSON.parse(data.join("\n"));
    // A failed replay ends with `event: error` + {error, sessionId, source} before
    // EOF from the sidecar: surface the sidecar's own message instead of the
    // generic "could not be read" text a schema miss would produce.
    if (raw && typeof raw === "object" && !("idx" in raw) && typeof (raw as { error?: unknown }).error === "string") {
      onProtocolError?.(`Codex stream error: ${(raw as { error: string }).error}`);
      return null;
    }
    const parsed = codexStreamEventSchema.safeParse(raw);
    // Never drop a wire event silently — schema drift here vanishes state updates
    // with no trace anywhere (exactly the "panel is silently stale" failure class).
    if (!parsed.success) onProtocolError?.("A Codex stream event could not be read. Refresh the session to recover its snapshot.");
    return parsed.success ? parsed.data : null;
  } catch { onProtocolError?.("A Codex stream event contained invalid JSON. Refresh the session to recover its snapshot."); return null; }
}

function findBoundary(value: string) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
