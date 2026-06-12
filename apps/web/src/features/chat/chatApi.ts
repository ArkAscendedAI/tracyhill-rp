import type {
  ChatSendRequest,
  GenerateImageRequest,
  ChatStreamEvent,
  SessionDetailResponse,
  SessionExportResponse,
  StopChatStreamResponse,
} from "@tracyhill-rp/contracts";
import { chatStreamEventSchema } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";


export function getSessionDetail(sessionId: string) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}`, { method: "GET" });
}

export function exportSessionMarkdown(sessionId: string) {
  return apiFetch<SessionExportResponse>(`/api/chat/sessions/${sessionId}/export`, { method: "GET" });
}

export function updateChatMessage(sessionId: string, messageId: string, payload: { content: string }) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}/messages/${messageId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteChatMessage(sessionId: string, messageId: string) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}/messages/${messageId}`, { method: "DELETE" });
}

export function truncateChatMessages(sessionId: string, messageId: string) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}/messages/truncate`, {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });
}

export function resolveSceneValidation(
  sessionId: string,
  messageId: string,
  payload: { choice: "main" | "validator" | "user"; userPresent?: string; userPresentUnaware?: string },
) {
  return apiFetch<{ detail: SessionDetailResponse; correctedScene: { location: string; present: string[]; presentUnaware: string[] } }>(
    `/api/chat/sessions/${sessionId}/messages/${messageId}/scene-resolve`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function editSceneMetadata(
  sessionId: string,
  messageId: string,
  payload: { location?: string; present?: string[]; presentUnaware?: string[]; reason?: string | null; date?: string | null; time?: string | null },
) {
  return apiFetch<SessionDetailResponse>(
    `/api/chat/sessions/${sessionId}/messages/${messageId}/scene-edit`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export async function streamSessionResponse(
  sessionId: string,
  requestId: string,
  payload: ChatSendRequest,
  onEvent: (event: ChatStreamEvent) => void,
) {
  try {
    const res = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({ error: "chat request failed" }));
      throw new Error(data.error ?? "chat request failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Track terminality: the server ends the stream after response.completed /
    // response.error with no sentinel. EOF WITHOUT one of those means the
    // connection died mid-generation (proxy timeout, network cut) — the old
    // loop resolved as if everything succeeded and the partial text silently
    // vanished (the exact failure mode of the 06-07 bridge incident, client
    // side). Surface it as an error instead.
    let terminalSeen = false;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const raw = parseSseChunk(chunk);
        if (raw) {
          // Lenient parse: an unknown event type from a newer server build must
          // be SKIPPED, not kill the stream (same class as the 05-22 session-
          // list fix). Known-but-malformed events are also skipped — terminal
          // tracking below catches a stream that ends without a valid terminal.
          const parsed = chatStreamEventSchema.safeParse(raw);
          if (parsed.success) {
            if (parsed.data.type === "response.completed" || parsed.data.type === "response.error") terminalSeen = true;
            onEvent(parsed.data);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    if (!terminalSeen) {
      throw new Error("Connection lost before the response completed — the server may still be generating; it will appear after a refresh");
    }
  } finally { /* nothing to clean up — server-side stopSessionResponse is the cancel path */ }
}

export function stopSessionResponse(sessionId: string, requestId: string) {
  return apiFetch<StopChatStreamResponse>(`/api/chat/sessions/${sessionId}/stream/stop`, {
    method: "POST",
    body: JSON.stringify({ requestId }),
  });
}

export function generateSessionImage(sessionId: string, payload: GenerateImageRequest) {
  return apiFetch<SessionDetailResponse>(`/api/images/sessions/${sessionId}/generate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function parseSseChunk(chunk: string) {
  let data = "";
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}
