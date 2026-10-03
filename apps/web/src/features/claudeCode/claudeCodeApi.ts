import type {
  ClaudeCodeAnswerRequest,
  ClaudeCodeCommandsResponse,
  ClaudeCodeDoctorResponse,
  ClaudeCodeForkRequest,
  ClaudeCodeForkResponse,
  ClaudeCodeFsTreeResponse,
  ClaudeCodeMemoryListResponse,
  ClaudeCodeMemoryReadResponse,
  ClaudeCodeMemoryWriteRequest,
  ClaudeCodeMemoryWriteResponse,
  ClaudeCodeMessagesResponse,
  ClaudeCodeModeRequest,
  ClaudeCodeOkResponse,
  ClaudeCodePatchRequest,
  ClaudeCodePatchResponse,
  ClaudeCodeRewindRequest,
  ClaudeCodeRewindResponse,
  ClaudeCodeSendRequest,
  ClaudeCodeSendResponse,
  ClaudeCodeSessionsResponse,
  ClaudeCodeStatusResponse,
  ClaudeCodeStreamEvent,
  ClaudeCodeUploadRequest,
  ClaudeCodeUploadResponse,
  KimiServingInfoResponse,
  KimiServingMode,
  KimiServingSetResponse,
} from "@tracyhill-rp/contracts";
import { claudeCodeStreamEventSchema } from "@tracyhill-rp/contracts";

import { apiFetch, apiFetchResponse } from "../../shared/api/client";

// Every function takes the backend `base` (e.g. "/api/claude-code" or
// "/api/kimi-code") as its first argument, defaulting to the Claude path so
// existing call sites keep working unchanged. Panel components pass their
// backend's apiBase (from useCodingBackend()).
const CC = "/api/claude-code";

export function getClaudeCodeSessions(base = CC) {
  return apiFetch<ClaudeCodeSessionsResponse>(`${base}/sessions`, { method: "GET" });
}

export function getClaudeCodeMessages(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeMessagesResponse>(`${base}/sessions/${sessionId}/messages`, { method: "GET" });
}

export function getClaudeCodeStatus(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeStatusResponse>(`${base}/sessions/${sessionId}/status`, { method: "GET" });
}

export function uploadClaudeCodeFile(base = CC, payload: ClaudeCodeUploadRequest) {
  return apiFetch<ClaudeCodeUploadResponse>(`${base}/upload`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendClaudeCodePrompt(base = CC, payload: ClaudeCodeSendRequest) {
  return apiFetch<ClaudeCodeSendResponse>(`${base}/send`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function interruptClaudeCodeSession(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/interrupt`, { method: "POST" });
}

export function deleteClaudeCodeSession(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}`, { method: "DELETE" });
}

export function patchClaudeCodeSession(base = CC, sessionId: string, patch: ClaudeCodePatchRequest) {
  return apiFetch<ClaudeCodePatchResponse>(`${base}/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function getClaudeCodeFsTree(base = CC, path?: string) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiFetch<ClaudeCodeFsTreeResponse>(`${base}/fs/tree${qs}`, { method: "GET" });
}

/**
 * Fetch the export through the authenticated boundary and save it from a Blob
 * URL with a `download` anchor. The old detached `a.click()` on the API URL
 * was an ordinary same-tab navigation: a 401 (lapsed session) or 400 (agent
 * down, unknown id) JSON reply replaced the SPA — draft, panel state and the
 * re-login overlay gone — and the 401 never reached onAuthInvalidated
 * (the Codex panel's export had the same fault). Rejects with the server's message so the
 * caller can surface it in place.
 */
export async function downloadClaudeCodeExport(base = CC, sessionId: string) {
  const response = await apiFetchResponse(`${base}/sessions/${encodeURIComponent(sessionId)}/export`, { method: "GET" });
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFilename(response.headers.get("content-disposition"), `${base.replace(/^\/api\//, "")}-${sessionId.slice(0, 8)}.md`);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The server's `Content-Disposition` filename when it sent one, else the fallback. */
export function exportFilename(contentDisposition: string | null, fallback: string): string {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const raw = match?.[1]?.trim();
  if (!raw) return fallback;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export function answerClaudeCodeQuestion(base = CC, sessionId: string, payload: ClaudeCodeAnswerRequest) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/answer`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getClaudeCodeDoctor(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeDoctorResponse>(`${base}/sessions/${sessionId}/doctor`, { method: "GET" });
}

export function listClaudeCodeMemory(base = CC) {
  return apiFetch<ClaudeCodeMemoryListResponse>(`${base}/memory`, { method: "GET" });
}

export function readClaudeCodeMemory(base = CC, path: string) {
  return apiFetch<ClaudeCodeMemoryReadResponse>(`${base}/memory/read?path=${encodeURIComponent(path)}`, { method: "GET" });
}

export function writeClaudeCodeMemory(base = CC, payload: ClaudeCodeMemoryWriteRequest) {
  return apiFetch<ClaudeCodeMemoryWriteResponse>(`${base}/memory/write`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function rewindClaudeCodeSession(base = CC, sessionId: string, payload: ClaudeCodeRewindRequest) {
  return apiFetch<ClaudeCodeRewindResponse>(`${base}/sessions/${sessionId}/rewind`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── v2 control surface ──

export function setClaudeCodeMode(base = CC, sessionId: string, payload: ClaudeCodeModeRequest) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function approveClaudeCodePlan(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/approve-plan`, { method: "POST" });
}

export function rejectClaudeCodePlan(base = CC, sessionId: string, feedback?: string) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/reject-plan`, {
    method: "POST",
    body: JSON.stringify(feedback ? { feedback } : {}),
  });
}

export function compactClaudeCodeSession(base = CC, sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`${base}/sessions/${sessionId}/compact`, { method: "POST" });
}

export function forkClaudeCodeSession(base = CC, sessionId: string, payload: ClaudeCodeForkRequest = {}) {
  return apiFetch<ClaudeCodeForkResponse>(`${base}/sessions/${sessionId}/fork`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getClaudeCodeCommands(base = CC, sessionId?: string) {
  const path = sessionId ? `${base}/sessions/${sessionId}/commands` : `${base}/commands`;
  return apiFetch<ClaudeCodeCommandsResponse>(path, { method: "GET" });
}

// ── Kimi serving swap (only mounted on the /api/kimi-code backend) ──
// (`/sessions/:id/context` and `/serving/probe` stay server-side for the
// Android panel; the web has no caller, so no client here.)

export function getKimiServingInfo(base: string) {
  return apiFetch<KimiServingInfoResponse>(`${base}/serving`, { method: "GET" });
}

export function setKimiServing(base: string, sessionId: string, mode: KimiServingMode) {
  return apiFetch<KimiServingSetResponse>(`${base}/sessions/${sessionId}/serving`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function streamClaudeCodeSession(base = CC, sessionId: string, after: number, onEvent: (event: ClaudeCodeStreamEvent) => void, signal?: AbortSignal) {
  // Through the shared authenticated boundary (as the Codex panel's stream
  // does): a 401 now notifies onAuthInvalidated (the re-login overlay) and
  // every non-2xx rejects with an ApiError carrying the status, so the hook
  // can stop for an access failure instead of retrying it six times as a
  // transport drop.
  const res = await apiFetchResponse(`${base}/sessions/${sessionId}/stream?after=${after}`, { method: "GET", signal });
  if (!res.body) throw new Error("Claude Code stream failed");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) { eventType = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || !eventType) continue;
      try {
        const parsed = JSON.parse(data) as { type?: string };
        if (!parsed.type) parsed.type = eventType;
        onEvent(claudeCodeStreamEventSchema.parse(parsed));
      } catch (error) {
        // A frame the schema refuses is skipped, but never silently: a schema that drifted from the service once
        // dropped the first tool call of most turns (2026-09-30).
        console.warn(`Claude Code stream: skipped a "${eventType}" frame that failed to parse`, error);
      }
      eventType = "";
    }
    if (done) break;
  }
}
