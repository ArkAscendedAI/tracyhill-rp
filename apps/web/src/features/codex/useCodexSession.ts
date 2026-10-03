import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodexSessionResponse, CodexSettingsResponse, CodexStreamEvent } from "@tracyhill-rp/contracts";
import { codexStreamEventSchema } from "@tracyhill-rp/contracts";

import { getCodexSession, streamCodexEvents } from "./codexApi";
import { ApiError } from "../../shared/api/client";
import { createUserScopedCacheWriter } from "../auth/authCache";
import { applyCodexMetadata, codexMetadataCursor, codexRuntimeCursor, metadataFromCodexSettings, reconcileCodexMetadata } from "./codexMetadata";
import { CodexEventReducer, EMPTY_CODEX_EVENT_STATE, type CodexEventState } from "./codexEvents";

type CodexConnectionHealth = "idle" | "connecting" | "live" | "reconnecting" | "offline";
type Acknowledgment = { revision: number; turnId?: string; activeThreadId?: string };

export function useCodexSession(sessionId: string | null) {
  const queryClient = useQueryClient();
  const acknowledgments = useRef(new Map<string, Acknowledgment>());
  const cacheUserQuery = useRef(createUserScopedCacheWriter(queryClient)).current;
  const stoppedForAccess = useRef(false);
  const completedTurns = useRef(new Map<string, Set<string>>());
  const protocolError = useRef<string | null>(null);
  const [connectionEpoch, reconnect] = useState(0);
  const detailQuery = useQuery({
    queryKey: ["codex-session", sessionId],
    queryFn: async ({ signal }) => {
      const id = sessionId!;
      const revision = acknowledgments.current.get(id)?.revision ?? 0;
      const started = queryClient.getQueryData<CodexSessionResponse>(["codex-session", id]);
      const incoming = await getCodexSession(id, signal);
      const detail = reconcileCodexMetadata(incoming, queryClient.getQueryData<CodexSessionResponse>(["codex-session", id]), started);
      const acknowledged = acknowledgments.current.get(id);
      // A response already serialized before a successful mutation can arrive
      // later. Keep the acknowledged fields while accepting its history/title.
      if (acknowledged && acknowledged.revision > revision) {
        const acknowledgedNative = [detail.thread, ...detail.descendants].find(thread => thread.id === acknowledged.activeThreadId)?.turns.find(turn => turn.id === acknowledged.turnId);
        if (acknowledged.turnId && (!acknowledgedNative || acknowledgedNative.status === "inProgress")) detail.runtime = { ...detail.runtime, activeTurnId: acknowledged.turnId, activeThreadId: acknowledged.activeThreadId, status: "running" };
      }
      const activeId = detail.runtime.activeTurnId;
      const activeThread = typeof detail.runtime.activeThreadId === "string" ? detail.runtime.activeThreadId : id;
      if (activeId && completedTurns.current.get(id)?.has(`${activeThread}:${activeId}`)) detail.runtime = { ...detail.runtime, activeTurnId: null, activeThreadId: null, status: "idle" };
      return detail;
    },
    enabled: Boolean(sessionId),
    retry: 1,
  });
  const [state, setState] = useState<{ sessionId: string | null; live: CodexEventState }>({ sessionId: null, live: EMPTY_CODEX_EVENT_STATE });
  const [connHealth, setConnHealth] = useState<CodexConnectionHealth>("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const cursorRef = useRef(-1);
  const ownerRef = useRef<object | null>(null);
  const pendingRef = useRef<CodexStreamEvent[]>([]);
  const sinceSnapshotRef = useRef<CodexStreamEvent[]>([]);
  const sinceSnapshotBytes = useRef(0);
  const frameRef = useRef<number | null>(null);
  const reducerRef = useRef<CodexEventReducer | null>(null);
  const detail = detailQuery.data;
  useEffect(() => {
    if (stoppedForAccess.current && detailQuery.isSuccess) { stoppedForAccess.current = false; reconnect(value => value + 1); }
  }, [detailQuery.dataUpdatedAt, detailQuery.isSuccess]);

  useEffect(() => {
    reducerRef.current = null;
    stoppedForAccess.current = false;
    protocolError.current = null;
    cursorRef.current = -1;
    pendingRef.current = [];
    sinceSnapshotRef.current = [];
    sinceSnapshotBytes.current = 0;
    setStreamError(null);
    setConnHealth(sessionId ? "connecting" : "idle");
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !detail) return;
    const seeded = detail.runtime.liveEvents.flatMap((candidate) => {
      const parsed = codexStreamEventSchema.safeParse(candidate);
      return parsed.success && parsed.data.idx <= detail.eventCursor ? [parsed.data] : [];
    });
    // Preserve everything delivered after the snapshot's cursor, including an
    // event queued for the next animation frame when this response arrives.
    const later = sinceSnapshotRef.current.filter(event => event.idx > detail.eventCursor);
    const reducer = new CodexEventReducer(sessionId);
    reducer.apply(seeded);
    reducer.seedRuntime(detail.runtime, codexRuntimeCursor(detail));
    if (codexMetadataCursor(detail, "settings") > codexRuntimeCursor(detail)) reducer.seedSettings({ model: detail.metadata.model, effort: detail.metadata.effort, serviceTier: detail.metadata.serviceTier, sandboxPolicy: { type: detail.metadata.mode === "yolo" ? "dangerFullAccess" : "readOnly" } }, codexMetadataCursor(detail, "settings"));
    if (detail.runtime.activeTurnId && detail.runtime.turnDiff?.diff) {
      const diff = detail.runtime.turnDiff as typeof detail.runtime.turnDiff & { threadId?: string };
      const threadId = diff.threadId || (typeof detail.runtime.activeThreadId === "string" ? detail.runtime.activeThreadId : sessionId);
      reducer.seedTurnDiff(threadId, detail.runtime.turnDiff.turnId ?? detail.runtime.activeTurnId, detail.runtime.turnDiff.diff);
    }
    reducer.seedGoal(detail.runtime.goal);
    if (detail.runtime.liveEventsTruncated) reducer.seedWarning("Earlier live output is outside the replay window. Snapshot items stay visible until their completed updates arrive.");
    reducer.apply(later);
    reducerRef.current = reducer;
    pendingRef.current = [];
    sinceSnapshotRef.current = later;
    sinceSnapshotBytes.current = later.reduce((size, event) => size + JSON.stringify(event).length, 0);
    cursorRef.current = Math.max(cursorRef.current, detail.eventCursor);
    setState({ sessionId, live: reducer.snapshot() });
  }, [sessionId, detail?.thread, detail?.runtime, detail?.eventCursor, detail?.runtimeEventCursor, detail?.clientMetadataMarks]);

  const hasDetail = Boolean(detail);
  useEffect(() => {
    if (!sessionId || !hasDetail) return;
    const owner = {};
    ownerRef.current = owner;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let refreshTimer: number | null = null;
    let attempt = 0;
    let connectedAt: number | null = null;
    let stopped = false;

    const refreshSoon = () => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (ownerRef.current !== owner) return;
        void queryClient.invalidateQueries({ queryKey: ["codex-session", sessionId] }, { cancelRefetch: false });
        void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
      }, 80);
    };
    const flush = () => {
      frameRef.current = null;
      const reducer = reducerRef.current;
      if (ownerRef.current !== owner || !reducer || !pendingRef.current.length) return;
      reducer.apply(pendingRef.current.splice(0));
      setState({ sessionId, live: reducer.snapshot() });
    };
    const connected = () => {
      if (ownerRef.current !== owner) return;
      connectedAt ??= Date.now();
      setConnHealth("live");
      setStreamError(protocolError.current);
    };
    const receive = (event: CodexStreamEvent) => {
      if (ownerRef.current !== owner || event.idx <= cursorRef.current) return;
      connected();
      cursorRef.current = event.idx;
      if (event.method === "turn/completed" && typeof event.params.threadId === "string" && typeof event.params.turn?.id === "string") {
        const completed = completedTurns.current.get(sessionId) ?? new Set<string>();
        completed.add(`${event.params.threadId}:${event.params.turn.id}`);
        completedTurns.current.set(sessionId, completed);
        const acknowledged = acknowledgments.current.get(sessionId);
        if (acknowledged && acknowledged.turnId === event.params.turn.id && acknowledged.activeThreadId === event.params.threadId) acknowledgments.current.set(sessionId, { ...acknowledged, turnId: undefined, activeThreadId: undefined });
      }
      if (event.params.threadId === sessionId && (event.method === "thread/settings/updated" || event.method === "thread/name/updated")) {
        const key = ["codex-session", sessionId]; const current = queryClient.getQueryData<CodexSessionResponse>(key);
        if (current) {
          const settings = event.method === "thread/settings/updated";
          const patch = settings ? metadataFromCodexSettings(event.params.threadSettings ?? {}) : { title: typeof event.params.threadName === "string" ? event.params.threadName : undefined };
          cacheUserQuery(key, applyCodexMetadata(current, patch, settings ? "settings" : "title", event.idx, "event"));
        }
      }
      pendingRef.current.push(event);
      sinceSnapshotRef.current.push(event);
      sinceSnapshotBytes.current += JSON.stringify(event).length;
      if (frameRef.current == null) frameRef.current = window.requestAnimationFrame(flush);
      if (["turn/completed", "thread/name/updated", "thread/settings/updated", "serverRequest/resolved", "item/tool/requestUserInput/resolved"].includes(event.method)) refreshSoon();
      // Periodically obtain a bounded snapshot instead of retaining an hours-long
      // raw replay log in addition to the reducer's current item contents.
      if (sinceSnapshotRef.current.length >= 1000 || sinceSnapshotBytes.current > 2_000_000) refreshSoon();
    };
    const disconnected = () => {
      // A valid header followed by immediate EOF is still a failed connection.
      // Keep retries persistent, but reset backoff only after 30 seconds of stability.
      if (connectedAt !== null && Date.now() - connectedAt >= 30_000) attempt = 0;
      attempt += 1;
      setConnHealth(attempt > 3 ? "offline" : "reconnecting");
    };
    const connect = async () => {
      if (stopped || ownerRef.current !== owner) return;
      controller = new AbortController();
      connectedAt = null;
      setConnHealth(attempt ? "reconnecting" : "connecting");
      try {
        await streamCodexEvents(sessionId, cursorRef.current, receive, controller.signal, connected, message => {
          if (ownerRef.current === owner) { protocolError.current = message; setStreamError(message); }
        });
        if (stopped || ownerRef.current !== owner) return;
        disconnected();
      } catch (error) {
        if (stopped || controller.signal.aborted || ownerRef.current !== owner) return;
        disconnected();
        setStreamError(error instanceof Error ? error.message : "Codex stream disconnected");
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { stoppedForAccess.current = true; setConnHealth("offline"); return; }
      }
      retryTimer = window.setTimeout(() => void connect(), Math.min(8_000, 500 * 2 ** Math.min(attempt, 4)));
    };
    void connect();
    return () => {
      stopped = true;
      if (ownerRef.current === owner) ownerRef.current = null;
      controller?.abort();
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingRef.current = [];
    };
  }, [sessionId, hasDetail, queryClient, connectionEpoch, cacheUserQuery]);

  const acknowledgeSettings = useCallback((id: string, settings: CodexSettingsResponse) => {
    const current = queryClient.getQueryData<CodexSessionResponse>(["codex-session", id]);
    if (current) cacheUserQuery(["codex-session", id], applyCodexMetadata(current, { mode: settings.mode, model: settings.model, effort: settings.effort, serviceTier: settings.serviceTier }, "settings", typeof settings.eventCursor === "number" ? settings.eventCursor : undefined));
  }, [queryClient, cacheUserQuery]);
  const acknowledgeTurn = useCallback((id: string, turnId: string, activeThreadId = id) => {
    const current = queryClient.getQueryData<CodexSessionResponse>(["codex-session", id]);
    const nativeTurn = [current?.thread, ...(current?.descendants ?? [])].find(thread => thread?.id === activeThreadId)?.turns.find(turn => turn.id === turnId);
    // Native terminal events can precede the HTTP start/review acknowledgment.
    // Neither that late response nor a snapshot it overlaps may revive the turn.
    if (completedTurns.current.get(id)?.has(`${activeThreadId}:${turnId}`) || nativeTurn && nativeTurn.status !== "inProgress" || id === sessionId && (reducerRef.current?.isTurnCompleted(activeThreadId, turnId) || pendingRef.current.some(event => event.method === "turn/completed" && event.params.threadId === activeThreadId && event.params.turn?.id === turnId))) return;
    const previous = acknowledgments.current.get(id);
    acknowledgments.current.set(id, { ...previous, revision: (previous?.revision ?? 0) + 1, turnId, activeThreadId });
    if (current) cacheUserQuery(["codex-session", id], { ...current, runtime: { ...current.runtime, activeTurnId: turnId, activeThreadId, status: "running" } });
  }, [queryClient, cacheUserQuery, sessionId]);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    await queryClient.invalidateQueries({ queryKey: ["codex-session", sessionId] });
    if (!queryClient.getQueryState(["codex-session", sessionId])?.error) { protocolError.current = null; setStreamError(null); }
  }, [queryClient, sessionId]);
  return { detailQuery, live: state.sessionId === sessionId ? state.live : EMPTY_CODEX_EVENT_STATE, connHealth, streamError, refresh, acknowledgeSettings, acknowledgeTurn };
}
