import type {
  ClaudeCodeAnswerRequest,
  ClaudeCodeCommandsResponse,
  ClaudeCodeContextResponse,
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
  ClaudeCodeSuggestionsResponse,
  ClaudeCodeTasksResponse,
  ClaudeCodeUploadRequest,
  ClaudeCodeUploadResponse,
} from "@tracyhill-rp/contracts";
import { claudeCodeStreamEventSchema } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getClaudeCodeSessions() {
  return apiFetch<ClaudeCodeSessionsResponse>("/api/claude-code/sessions", { method: "GET" });
}

export function getClaudeCodeMessages(sessionId: string) {
  return apiFetch<ClaudeCodeMessagesResponse>(`/api/claude-code/sessions/${sessionId}/messages`, { method: "GET" });
}

export function getClaudeCodeStatus(sessionId: string) {
  return apiFetch<ClaudeCodeStatusResponse>(`/api/claude-code/sessions/${sessionId}/status`, { method: "GET" });
}

export function uploadClaudeCodeFile(payload: ClaudeCodeUploadRequest) {
  return apiFetch<ClaudeCodeUploadResponse>("/api/claude-code/upload", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendClaudeCodePrompt(payload: ClaudeCodeSendRequest) {
  return apiFetch<ClaudeCodeSendResponse>("/api/claude-code/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function interruptClaudeCodeSession(sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/interrupt`, { method: "POST" });
}

export function deleteClaudeCodeSession(sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}`, { method: "DELETE" });
}

export function patchClaudeCodeSession(sessionId: string, patch: ClaudeCodePatchRequest) {
  return apiFetch<ClaudeCodePatchResponse>(`/api/claude-code/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function getClaudeCodeFsTree(path?: string) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiFetch<ClaudeCodeFsTreeResponse>(`/api/claude-code/fs/tree${qs}`, { method: "GET" });
}

export function downloadClaudeCodeExport(sessionId: string) {
  const url = `/api/claude-code/sessions/${sessionId}/export`;
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.click();
}

export function answerClaudeCodeQuestion(sessionId: string, payload: ClaudeCodeAnswerRequest) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/answer`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getClaudeCodeDoctor(sessionId: string) {
  return apiFetch<ClaudeCodeDoctorResponse>(`/api/claude-code/sessions/${sessionId}/doctor`, { method: "GET" });
}

export function listClaudeCodeMemory() {
  return apiFetch<ClaudeCodeMemoryListResponse>("/api/claude-code/memory", { method: "GET" });
}

export function readClaudeCodeMemory(path: string) {
  return apiFetch<ClaudeCodeMemoryReadResponse>(`/api/claude-code/memory/read?path=${encodeURIComponent(path)}`, { method: "GET" });
}

export function writeClaudeCodeMemory(payload: ClaudeCodeMemoryWriteRequest) {
  return apiFetch<ClaudeCodeMemoryWriteResponse>("/api/claude-code/memory/write", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function rewindClaudeCodeSession(sessionId: string, payload: ClaudeCodeRewindRequest) {
  return apiFetch<ClaudeCodeRewindResponse>(`/api/claude-code/sessions/${sessionId}/rewind`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function executeClaudeCodePlan(sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/execute-plan`, {
    method: "POST",
  });
}

// ── v2 control surface ──

export function setClaudeCodeMode(sessionId: string, payload: ClaudeCodeModeRequest) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function approveClaudeCodePlan(sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/approve-plan`, { method: "POST" });
}

export function rejectClaudeCodePlan(sessionId: string, feedback?: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/reject-plan`, {
    method: "POST",
    body: JSON.stringify(feedback ? { feedback } : {}),
  });
}

export function getClaudeCodeContext(sessionId: string) {
  return apiFetch<ClaudeCodeContextResponse>(`/api/claude-code/sessions/${sessionId}/context`, { method: "GET" });
}

export function compactClaudeCodeSession(sessionId: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/compact`, { method: "POST" });
}

export function setClaudeCodeModel(sessionId: string, model: string) {
  return apiFetch<ClaudeCodeOkResponse>(`/api/claude-code/sessions/${sessionId}/model`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

export function forkClaudeCodeSession(sessionId: string, payload: ClaudeCodeForkRequest = {}) {
  return apiFetch<ClaudeCodeForkResponse>(`/api/claude-code/sessions/${sessionId}/fork`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getClaudeCodeTasks(sessionId: string) {
  return apiFetch<ClaudeCodeTasksResponse>(`/api/claude-code/sessions/${sessionId}/tasks`, { method: "GET" });
}

export function getClaudeCodeCommands(sessionId?: string) {
  const path = sessionId ? `/api/claude-code/sessions/${sessionId}/commands` : "/api/claude-code/commands";
  return apiFetch<ClaudeCodeCommandsResponse>(path, { method: "GET" });
}

export function getClaudeCodeSuggestions(sessionId: string) {
  return apiFetch<ClaudeCodeSuggestionsResponse>(`/api/claude-code/sessions/${sessionId}/suggestions`, { method: "GET" });
}

export async function streamClaudeCodeSession(sessionId: string, after: number, onEvent: (event: ClaudeCodeStreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/claude-code/sessions/${sessionId}/stream?after=${after}`, {
    method: "GET",
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: "Claude Code stream failed" }));
    throw new Error(data.error ?? "Claude Code stream failed");
  }
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
      } catch {
        // ignore malformed frames
      }
      eventType = "";
    }
    if (done) break;
  }
}
