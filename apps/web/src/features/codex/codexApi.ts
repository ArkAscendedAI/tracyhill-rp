import type {
  CodexMessagesResponse,
  CodexOutputResponse,
  CodexSendRequest,
  CodexSessionsResponse,
  CodexStatusResponse,
  CodexStreamEvent,
  CodexUploadRequest,
  CodexUploadResponse,
} from "@tracyhill-rp/contracts";
import { codexStreamEventSchema } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getCodexStatus() {
  return apiFetch<CodexStatusResponse>("/api/codex/status", { method: "GET" });
}

export function getCodexSessions() {
  return apiFetch<CodexSessionsResponse>("/api/codex/sessions", { method: "GET" });
}

export function getCodexMessages(sessionId: string) {
  return apiFetch<CodexMessagesResponse>(`/api/codex/sessions/${sessionId}/messages`, { method: "GET" });
}

export function getCodexCommandOutput(sessionId: string, itemId: string) {
  return apiFetch<CodexOutputResponse>(`/api/codex/sessions/${sessionId}/output/${itemId}`, { method: "GET" });
}

export function uploadCodexFile(payload: CodexUploadRequest) {
  return apiFetch<CodexUploadResponse>("/api/codex/upload", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function interruptCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`/api/codex/sessions/${sessionId}/interrupt`, { method: "POST" });
}

export function deleteCodexSession(sessionId: string) {
  return apiFetch<{ ok: true }>(`/api/codex/sessions/${sessionId}`, { method: "DELETE" });
}

export async function streamCodexSession(payload: CodexSendRequest, onEvent: (event: CodexStreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch("/api/codex/send", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: "codex request failed" }));
    throw new Error(data.error ?? "codex request failed");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseChunk(chunk);
      if (event) {
        // Lenient: an unknown event type from a newer codex bridge must be
        // skipped, not throw a ZodError that kills the whole stream.
        const parsed = codexStreamEventSchema.safeParse(event);
        if (parsed.success) onEvent(parsed.data);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

function parseSseChunk(chunk: string) {
  let eventType = "";
  let data = "";
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  let parsed: { type?: string };
  try { parsed = JSON.parse(data) as { type?: string }; } catch { return null; }
  if (!parsed.type && eventType) parsed.type = eventType;
  return parsed;
}
