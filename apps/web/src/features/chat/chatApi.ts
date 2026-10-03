import type {
  ChatSendRequest,
  GenerateImageRequest,
  ChatStreamEvent,
  SceneOutlineResponse,
  SessionDetailResponse,
  SessionExportResponse,
  StopChatStreamResponse,
} from "@tracyhill-rp/contracts";
import { chatStreamEventSchema, messageContextSnapshotResponseSchema } from "@tracyhill-rp/contracts";

import { ApiError, apiFetch } from "../../shared/api/client";


// Default load returns the newest window + pagination + sessionStats; pass
// `before` (the current oldest sortOrder) to fetch the previous window only, or
// `after` (scene jump) to window FORWARD from a cursor. Mutually exclusive.
export function getSessionDetail(sessionId: string, opts?: { before?: number; after?: number; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.before != null) params.set("before", String(opts.before));
  if (opts?.after != null) params.set("after", String(opts.after));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}${qs ? `?${qs}` : ""}`, { method: "GET" });
}

/** Refresh an already-loaded historical range, including replacement variants and deletions. */
export async function refreshMessageRange(sessionId: string, previous: SessionDetailResponse["messages"]) {
  if (!previous.length) return previous;
  const end = previous[previous.length - 1]!.sortOrder;
  let after = previous[0]!.sortOrder - 1;
  const messages: SessionDetailResponse["messages"] = [];
  while (after < end) {
    const page = await getSessionDetail(sessionId, { after, limit: 500 });
    const last = page.messages[page.messages.length - 1]?.sortOrder;
    messages.push(...page.messages.filter((message) => message.sortOrder <= end));
    if (last == null || !page.pagination.hasNewer || last >= end) break;
    if (last <= after) throw new Error("Historical message refresh did not advance");
    after = last;
  }
  return messages;
}

/** Install a refreshed window without removing pages loaded in parallel or overwriting newer rows. */
export function reconcileMessageRange(
  current: SessionDetailResponse["messages"],
  previous: SessionDetailResponse["messages"],
  refreshed: SessionDetailResponse["messages"],
): SessionDetailResponse["messages"] {
  if (!previous.length) return current;
  if (current === previous) return refreshed;
  const start = previous[0]!.sortOrder;
  const end = previous[previous.length - 1]!.sortOrder;
  const before = new Map(previous.map((message) => [message.sortOrder, message]));
  const now = new Map(current.map((message) => [message.sortOrder, message]));
  const fresh = new Map(refreshed.map((message) => [message.sortOrder, message]));
  const result: SessionDetailResponse["messages"] = [];
  for (const order of [...new Set([...now.keys(), ...fresh.keys()])].sort((a, b) => a - b)) {
    const currentRow = now.get(order);
    const freshRow = fresh.get(order);
    // Completion and its validator can arrive in the same SSE batch. The row
    // installed by completion is newer than the old snapshot, but the refetch
    // may safely enrich that exact content/scene version with saved metadata.
    const sameContentVersion = currentRow && freshRow && currentRow.id === freshRow.id
      && currentRow.content === freshRow.content && currentRow.sceneData === freshRow.sceneData
      && currentRow.updatedAt <= freshRow.updatedAt;
    const unchanged = currentRow === before.get(order) || sameContentVersion;
    const message = order >= start && order <= end && unchanged ? fresh.get(order) : now.get(order);
    if (message) result.push(message);
  }
  return result;
}

// Scene/date outline: location + in-world date/time per active scene-bearing
// message — small payload independent of the transcript window.
/**
 * A reply's stored context snapshot: the `response.context` of the turn
 * that produced it, kept for the session's newest 50 replies. 404 when the reply has none.
 * Parsed through the contract rather than cast (a cast let a renamed field go unseen).
 */
export async function getMessageContextSnapshot(sessionId: string, messageId: string) {
  const body = await apiFetch<unknown>(`/api/chat/sessions/${sessionId}/messages/${messageId}/context`, { method: "GET" });
  return messageContextSnapshotResponseSchema.parse(body);
}

export function getSceneOutline(sessionId: string) {
  return apiFetch<SceneOutlineResponse>(`/api/chat/sessions/${sessionId}/scene-outline`, { method: "GET" });
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

/**
 * Delete every message after `messageId`. A caller that cuts in order to replace the row after the cut (Resend, the
 * scene auto-regen) names that row as `expectNextMessageId`: the server then refuses with 409 unless it is the first
 * row after the cut, so a transcript holding rows it never loaded cannot delete them.
 */
export function truncateChatMessages(sessionId: string, messageId: string, opts?: { expectNextMessageId?: string; expectLastMessageId?: string; confirmDeleteCount?: number }) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}/messages/truncate`, {
    method: "POST",
    body: JSON.stringify({
      messageId,
      ...(opts?.expectNextMessageId ? { expectNextMessageId: opts.expectNextMessageId } : {}),
      // The last message this client has, and the count the person confirmed (truncateGuard.ts).
      ...(opts?.expectLastMessageId ? { expectLastMessageId: opts.expectLastMessageId } : {}),
      ...(opts?.confirmDeleteCount !== undefined ? { confirmDeleteCount: opts.confirmDeleteCount } : {}),
    }),
  });
}

/**
 * The server refused a guarded truncate and deleted nothing: the chat changed since it was loaded (409, the
 * replaced-row check and the stale-tab guard), or the count it would remove is not the one confirmed (428). Either
 * way the chat reloads.
 */
export function isChatChangedRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 428);
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

export function streamSessionResponse(
  sessionId: string,
  requestId: string,
  payload: ChatSendRequest,
  onEvent: (event: ChatStreamEvent) => void,
) {
  return streamChatSse(`/api/chat/sessions/${sessionId}/stream`, requestId, payload, onEvent);
}

// Message branching / swipes: regenerate streams a NEW sibling variant (the prior
// reply is preserved, not destroyed). The sibling routes `/continue` (append in
// place after a max_tokens truncation) and `/edit-regenerate` (edit a user turn
// + rerun from it) stay live for the Android client; the web has no affordance
// for either, so their helpers were removed here;
// re-add them alongside the UI if web parity is wanted.
export function regenerateMessageStream(
  sessionId: string,
  messageId: string,
  requestId: string,
  payload: { modelId?: string; rollOverride?: boolean },
  onEvent: (event: ChatStreamEvent) => void,
) {
  return streamChatSse(`/api/chat/sessions/${sessionId}/messages/${messageId}/regenerate`, requestId, payload, onEvent);
}

export function switchMessageVariant(sessionId: string, variantMessageId: string) {
  return apiFetch<SessionDetailResponse>(`/api/chat/sessions/${sessionId}/variants/switch`, {
    method: "POST",
    body: JSON.stringify({ variantMessageId }),
  });
}

async function streamChatSse(
  path: string,
  requestId: string,
  payload: unknown,
  onEvent: (event: ChatStreamEvent) => void,
) {
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: {
        // CSRF fallback header, same as every apiFetch call.
        "x-requested-with": "XMLHttpRequest",
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
    // vanished. Surface it as an error instead.
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
