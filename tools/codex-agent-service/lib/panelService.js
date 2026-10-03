import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { BOOT_COMPACT_MIN_BYTES, CODEX_BIN, LIVE_EVENTS_MAX_BYTES, UPLOAD_DIR, listWorkspaces, workspaceById } from "./config.js";
import { buildInputs, exportThreadMarkdown, modeToSandbox, sandboxToMode, threadToSummary } from "./format.js";
import { DURABLE_SNAPSHOT_METHODS } from "./latestSnapshots.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_EFFORT = "max";
const DEFAULT_MODE = "read-only";
// Idle sessions re-read from the App Server at most once per TTL; any event or
// panel mutation for a session invalidates its entry immediately, so active
// sessions always render fresh. Without this, the rail's 3s poll issued one
// thread/read RPC per manifest session per poll — O(sessions) fan-out.
const SUMMARY_CACHE_TTL_MS = 60_000;
// getSession turn window. Root turns render in the transcript; descendant (subagent) threads
// are collapsed by default and can number in the hundreds, so they are sliced far shallower.
const DEFAULT_TURN_LIMIT = 40;
const DEFAULT_DESCENDANT_TURN_LIMIT = 4;
const MAX_TURN_LIMIT = 500;
// Native turn paging. thread/turns/list serves
// newest-first pages with a bound; thread/read(includeTurns: true) hydrates the
// whole history in one RPC — the 60 s App Server request timeout was the real
// bound on a long session, and the App Server deprecates that read for
// paginated threads. Shell pages (itemsView "notLoaded") count what a window
// withheld; both caps make an absurd thread a floor, never a hang.
const TURN_PAGE_SIZE = 100;
const TURN_COUNT_PAGE_SIZE = 500;
const MAX_TURN_COUNT_PAGES = 40;
// Descendant (subagent) threads read for the screen: the newest by
// recency; the listing is paged to count the rest so the window is disclosed.
const DESCENDANT_THREAD_LIMIT = 50;
const MAX_DESCENDANT_LIST_PAGES = 20;
const DESCENDANT_SOURCE_KINDS = ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"];
// Panel uploads. A prepared upload belongs to a
// draft that can sit for hours (web/Android keep drafts indefinitely), so a
// never-sent upload lives UPLOAD_DRAFT_TTL_MS from its upload time, while one a
// turn or steer consumed is released UPLOAD_CONSUMED_TTL_MS after that use
// (the old flat 2 h reaped drafts' files under them). A send whose upload is
// already gone fails with a clear 400 instead of starting a turn the App
// Server runs without the file.
export const UPLOAD_DRAFT_TTL_MS = 24 * 3600_000;
export const UPLOAD_CONSUMED_TTL_MS = 2 * 3600_000;
const CONSUMED_UPLOADS_MAX = 2000;
function clampTurnLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_TURN_LIMIT);
}

export class PanelService {
  constructor({ client, manifest, events, uploadDir = UPLOAD_DIR }) {
    this.client = client;
    this.manifest = manifest;
    this.events = events;
    this.uploadDir = resolve(uploadDir);
    // upload path → ms when a turn/steer consumed it (server.js's reaper asks).
    this.consumedUploads = new Map();
    this.runtime = new Map();
    this.threadRoots = new Map();
    this.loadedThreads = new Set();
    this.pendingInputs = new Map();
    this.inputGeneration = randomUUID();
    this.warnings = [];
    this.models = null;
    this.modelsFetchedAt = 0;
    this.summaryCache = new Map();
    this.mutations = new Map();
    this.turnStates = new Map();
    this.hydrated = new Set();
    this.hydrating = new Map();
    this.runtimeVersions = new Map();
    this.turnDiffs = new Map();
    this.pendingReviews = new Set();
    this.reviewMessages = [];
    this.reviewBytes = 0;

    // Every emitter-driven handler runs inside #guarded: the App
    // Server client dispatches these straight from readline's `line` event,
    // so a throw here used to be an uncaught exception that killed the whole
    // sidecar (every panel turn and Composer call, then the boot-compaction
    // window — a crash loop on a persistent cause such as a full disk).
    client.on("notification", (message) => this.#guarded("notification", message, () => this.#onNotification(message)));
    client.on("request", (message) => this.#guarded("request", message, () => this.#onServerRequest(message)));
    client.on("stderr", (message) => this.#rememberWarning(message));
    client.on("exit", (error) => this.#guarded("exit", null, () => this.#onClientExit(error)));
    events.on("snapshotWarning", (message) => this.#rememberWarning(message));
  }

  async start() {
    // Nothing is in flight yet: any rewrite temp file is an orphan.
    const swept = this.events.sweepTemp();
    if (swept) console.log(`[events] boot sweep removed ${swept} orphaned rewrite file(s)`);
    const sessionIds = this.manifest.list().map((session) => session.sessionId);
    const recovered = await this.events.recoverInterrupted(sessionIds);
    for (const sessionId of recovered) this.manifest.upsert(sessionId, { lastError: "Bridge restarted during an active turn" });
    for (const sessionId of sessionIds) {
      if (this.events.sizeOf(sessionId) < BOOT_COMPACT_MIN_BYTES) continue;
      const result = await this.events.compactCompleted(sessionId);
      console.log(`[events] boot compaction ${sessionId}: kept ${result.kept}, dropped ${result.dropped}${result.error ? `, error: ${result.error}` : ""}`);
    }
    await this.client.start();
    await this.getModels(true);
    this.events.prune((sessionId) => Boolean(this.runtime.get(sessionId)?.activeTurnId));
  }

  async getStatus() {
    const models = await this.getModels();
    const initialize = this.client.initializeResult ?? await this.client.start();
    return {
      ok: true,
      serviceVersion: "2.0.0",
      protocol: "codex-app-server",
      cliVersion: extractCliVersion(initialize?.userAgent),
      codexHome: initialize?.codexHome,
      workspaces: listWorkspaces(),
      models,
      defaultModel: models.find((model) => model.isDefault)?.id || DEFAULT_MODEL,
      defaultEffort: preferredEffort(models.find((model) => model.isDefault) || models[0]) || DEFAULT_EFFORT,
      modes: [
        { id: "read-only", name: "Read Only", description: "Inspect and reason without writing files or using the network." },
        { id: "yolo", name: "YOLO", description: "Full host access with approvals disabled." },
      ],
      activeSessions: [...this.runtime.values()].filter((runtime) => runtime.activeTurnId).length,
      legacySessionCount: this.manifest.legacyCount(),
      warnings: this.warnings.slice(-10),
    };
  }

  async getModels(force = false) {
    if (!force && this.models && Date.now() - this.modelsFetchedAt < 5 * 60_000) return this.models;
    const nativeModels = [], cursors = new Set();
    let cursor = null;
    do {
      const result = await this.client.request("model/list", { cursor, limit: 100, includeHidden: false });
      nativeModels.push(...(result?.data ?? []));
      cursor = result?.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error("Codex model pagination repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.models = [...new Map(nativeModels.map(model => [model.id, model])).values()].map((model) => ({
      id: model.id,
      displayName: model.displayName || model.id,
      description: model.description || "",
      isDefault: Boolean(model.isDefault),
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((entry) => ({ id: entry.reasoningEffort, description: entry.description || "" })),
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      inputModalities: model.inputModalities ?? ["text"],
      supportsPersonality: Boolean(model.supportsPersonality),
      serviceTiers: model.serviceTiers ?? [],
      defaultServiceTier: model.defaultServiceTier ?? null,
    }));
    this.modelsFetchedAt = Date.now();
    return this.models;
  }

  async listSessions() {
    const metadata = this.manifest.list();
    const now = Date.now();
    const settled = await Promise.allSettled(metadata.map(async (session) => {
      const cached = this.summaryCache.get(session.sessionId);
      if (cached && now - cached.at < SUMMARY_CACHE_TTL_MS) return cached.summary;
      const cursor = this.events.currentIndex(session.sessionId);
      const result = await this.client.request("thread/read", { threadId: session.sessionId, includeTurns: false });
      const current = this.#requireSession(session.sessionId);
      const summary = threadToSummary(result.thread, current, this.#runtime(session.sessionId));
      // A late read cannot repopulate a cache invalidated while it awaited RPC.
      if (cursor === this.events.currentIndex(session.sessionId) && JSON.stringify(current) === JSON.stringify(session)) this.summaryCache.set(session.sessionId, { summary, at: now });
      return summary;
    }));
    return settled.map((result, index) => result.status === "fulfilled" ? result.value : {
      ...metadata[index],
      active: false,
      status: "unavailable",
      lastError: result.reason instanceof Error ? result.reason.message : "Native Codex thread is unavailable",
    }).filter((session) => this.manifest.has(session.sessionId))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  // Turns are unbounded on long-lived sessions: a 3-day agent run reached ~114 MB of thread
  // JSON and 32s to serialize, past the panel bridge's timeout, so the session could not be
  // opened at all. The root thread is read metadata-only and its newest window of turns is
  // paged natively — no RPC ever carries the whole history — and what was withheld
  // is reported. Descendant (subagent) threads are collapsed in the UI and can number in the
  // hundreds, so only the newest DESCENDANT_THREAD_LIMIT are read, each with a much shallower
  // turn slice than the root, and the thread count withheld is disclosed too.
  async getSession(sessionId, options = {}) {
    this.#requireSession(sessionId);
    // Capture a replay boundary BEFORE any native snapshot RPC. Completion or
    // settings notifications received while descendants are read must remain
    // replayable; a cursor captured afterwards silently acknowledges them.
    const eventCursor = this.events.currentIndex(sessionId);
    const activeTurnStartIdx = this.#runtime(sessionId).activeTurnStartIdx;
    await this.#hydrateRuntime(sessionId);
    const limit = clampTurnLimit(options.turnLimit, DEFAULT_TURN_LIMIT);
    const descendantLimit = clampTurnLimit(options.descendantTurnLimit, DEFAULT_DESCENDANT_TURN_LIMIT);
    const result = await this.client.request("thread/read", { threadId: sessionId, includeTurns: false });
    const rootWindow = await this.#readTurnWindow(sessionId, limit);
    const listing = await this.#getDescendants(sessionId, { descendantLimit });
    const descendants = listing.threads;
    const runtime = this.#runtime(sessionId);
    const { events: liveEvents, truncated: liveEventsTruncated } = activeTurnStartIdx == null
      ? { events: [], truncated: false }
      : await this.events.readTail(sessionId, activeTurnStartIdx - 1, LIVE_EVENTS_MAX_BYTES, eventCursor);
    const metadata = this.#requireSession(sessionId);
    // No await from this boundary through the returned runtime/question copy.
    // Native transcript reads can be older than these cumulative snapshots.
    const runtimeEventCursor = this.events.currentIndex(sessionId);
    const descendantReturned = descendants.reduce((sum, t) => sum + (Array.isArray(t?.turns) ? t.turns.length : 0), 0);
    return {
      thread: { ...result.thread, turns: rootWindow.turns },
      descendants,
      metadata,
      runtime: { ...runtime, liveEvents, liveEventsTruncated, pendingQuestions: this.#pendingForSession(sessionId) },
      eventCursor,
      runtimeEventCursor,
      turnWindow: {
        limit, descendantLimit,
        rootTotal: rootWindow.total, rootReturned: rootWindow.turns.length,
        descendantTotal: listing.turnTotal, descendantReturned,
        descendantThreadTotal: listing.threadTotal, descendantThreadReturned: descendants.length,
        truncated: rootWindow.turns.length < rootWindow.total || descendantReturned < listing.turnTotal || descendants.length < listing.threadTotal,
      },
    };
  }

  getSessionStatus(sessionId) {
    const metadata = this.#requireSession(sessionId);
    // Status is polled — never ship the full diff/goal snapshots here.
    const { turnDiff, goal, ...runtime } = this.#runtime(sessionId);
    return { sessionId, ...runtime, metadata, eventCursor: this.events.currentIndex(sessionId), pendingQuestions: this.#pendingForSession(sessionId) };
  }

  isActive(sessionId) { return Boolean(this.runtime.get(sessionId)?.activeTurnId); }
  hasSession(sessionId) { return this.manifest.has(sessionId); }

  async startTurn(payload) {
    return payload.sessionId ? this.#mutate(payload.sessionId, () => this.#startTurn(payload)) : this.#startTurn(payload);
  }

  async #startTurn(payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const catalog = await this.getModels();
    // Resuming a session inherits ITS settings for anything the request omits.
    // The global default used to win instead, re-targeting a deliberately
    // gpt-5.5/xhigh session to sol/max (and read-only) via
    // thread/settings/update and persisting it. Effort is inherited
    // only while it is still valid for the model actually used; serviceTier
    // is inherited only when the key is absent (an explicit null means the
    // default tier).
    const existing = payload.sessionId ? this.#requireSession(payload.sessionId) : null;
    const model = payload.model || existing?.model || catalog.find((entry) => entry.isDefault)?.id || DEFAULT_MODEL;
    const modelInfo = catalog.find((entry) => entry.id === model);
    const supportedEfforts = modelInfo?.supportedReasoningEfforts.map((entry) => entry.id) || [];
    const inheritedEffort = existing && existing.model === model && supportedEfforts.includes(existing.effort) ? existing.effort : null;
    const effort = payload.effort || inheritedEffort || (supportedEfforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : modelInfo?.defaultReasoningEffort);
    const mode = payload.mode || existing?.mode || DEFAULT_MODE;
    const serviceTier = Object.hasOwn(payload, "serviceTier") ? payload.serviceTier ?? null : existing?.serviceTier ?? null;
    await this.#validateSettings(model, effort, serviceTier, mode);
    this.#consumeUploads(files);

    let sessionId = payload.sessionId || null;
    let metadata;
    let eventCursor = -1;
    if (sessionId) {
      metadata = existing;
      if (this.#runtime(sessionId).activeTurnId) throw httpError(409, "Session already has an active turn; steer or interrupt it first");
      eventCursor = this.events.currentIndex(sessionId);
      await this.#ensureLoaded(sessionId, { ...metadata, model, effort, serviceTier, mode });
      await this.#applySettings(sessionId, { model, effort, serviceTier, mode });
    } else {
      const workspace = payload.workspaceId ? workspaceById(payload.workspaceId) : listWorkspaces()[0];
      if (!workspace) throw httpError(400, "Invalid workspace");
      const sandbox = modeToSandbox(mode);
      const started = await this.client.request("thread/start", {
        model,
        serviceTier,
        cwd: workspace.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: sandbox.cli,
        config: { model_reasoning_effort: effort },
        serviceName: "tracyhill-rp-codex-panel",
      }, 120_000);
      sessionId = started.thread.id;
      this.loadedThreads.add(sessionId);
      this.threadRoots.set(sessionId, sessionId);
      metadata = this.manifest.upsert(sessionId, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        mode,
        model: started.model || model,
        effort: started.reasoningEffort || effort,
        serviceTier,
        pinned: false,
      });
    }

    const prompt = String(payload.prompt || "").trim();
    const inputs = buildInputs(prompt, files);
    const sandbox = modeToSandbox(mode);
    const turn = await this.client.request("turn/start", {
      threadId: sessionId,
      input: inputs,
      cwd: metadata.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: sandbox.policy,
      model,
      serviceTier,
      effort,
    }, 120_000);
    this.#acknowledgeTurn(sessionId, sessionId, turn.turn, eventCursor);
    const observed = this.turnStates.get(`${sessionId}:${turn.turn.id}`);
    this.manifest.upsert(sessionId, { lastPrompt: prompt.slice(0, 500), lastError: observed?.turn.error?.message || null });
    this.summaryCache.delete(sessionId);
    return { sessionId, turnId: turn.turn.id, eventCursor };
  }

  async steer(sessionId, payload) {
    this.#requireSession(sessionId);
    const runtime = this.#runtime(sessionId);
    if (!runtime.activeTurnId) throw httpError(409, "Session has no active turn");
    this.#consumeUploads(Array.isArray(payload.files) ? payload.files : []);
    await this.client.request("turn/steer", {
      threadId: runtime.activeThreadId || sessionId,
      expectedTurnId: runtime.activeTurnId,
      input: buildInputs(payload.prompt, payload.files || []),
    });
    return { ok: true };
  }

  async updateSettings(sessionId, patch) {
    return this.#mutate(sessionId, () => this.#updateSettings(sessionId, patch));
  }

  async #updateSettings(sessionId, patch) {
    const metadata = this.#requireSession(sessionId);
    const next = {
      mode: patch.mode ?? metadata.mode ?? DEFAULT_MODE,
      model: patch.model ?? metadata.model ?? DEFAULT_MODEL,
      effort: patch.effort ?? metadata.effort ?? DEFAULT_EFFORT,
      serviceTier: normalizeServiceTier(Object.hasOwn(patch, "serviceTier") ? patch.serviceTier : metadata.serviceTier),
    };
    await this.#validateSettings(next.model, next.effort, next.serviceTier, next.mode);
    await this.#ensureLoaded(sessionId, { ...metadata, ...next });
    await this.#applySettings(sessionId, next);
    const applied = this.#requireSession(sessionId);
    return { ok: true, mode: applied.mode, model: applied.model, effort: applied.effort, serviceTier: applied.serviceTier ?? null, eventCursor: this.events.currentIndex(sessionId) };
  }

  async patchSession(sessionId, patch) {
    return this.#mutate(sessionId, () => this.#patchSession(sessionId, patch));
  }

  async #patchSession(sessionId, patch) {
    this.#requireSession(sessionId);
    const titleVersion = this.#runtimeVersion(sessionId, "title");
    if (typeof patch.title === "string") {
      const title = patch.title.trim();
      if (!title) throw httpError(400, "Title cannot be empty");
      await this.client.request("thread/name/set", { threadId: sessionId, name: title });
    }
    // Merge only requested fields. A native name notification received before
    // the acknowledgement is authoritative over the original requested title.
    this.#requireSession(sessionId);
    this.summaryCache.delete(sessionId);
    const metadata = this.manifest.upsert(sessionId, {
      ...(typeof patch.title === "string" && titleVersion === this.#runtimeVersion(sessionId, "title") ? { title: patch.title.trim() } : {}),
      ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
    });
    return { ...metadata, eventCursor: this.events.currentIndex(sessionId) };
  }

  async interrupt(sessionId) {
    this.#requireSession(sessionId);
    const runtime = this.#runtime(sessionId);
    if (!runtime.activeTurnId) throw httpError(404, "Session is not running");
    await this.client.request("turn/interrupt", { threadId: runtime.activeThreadId || sessionId, turnId: runtime.activeTurnId });
    return { ok: true };
  }

  async compact(sessionId) {
    return this.#mutate(sessionId, () => this.#compact(sessionId));
  }

  async #compact(sessionId) {
    this.#requireSession(sessionId);
    await this.#ensureLoaded(sessionId, this.manifest.get(sessionId));
    await this.client.request("thread/compact/start", { threadId: sessionId }, 120_000);
    return { ok: true };
  }

  async fork(sessionId, payload = {}) {
    return this.#mutate(sessionId, () => this.#fork(sessionId, payload));
  }

  async #fork(sessionId, payload) {
    const metadata = this.#requireSession(sessionId);
    if (this.#runtime(sessionId).activeTurnId) throw httpError(409, "Interrupt the active turn before forking");
    const sandbox = modeToSandbox(metadata.mode || DEFAULT_MODE);
    const result = await this.client.request("thread/fork", {
      threadId: sessionId,
      lastTurnId: payload.lastTurnId ?? null,
      model: metadata.model,
      serviceTier: metadata.serviceTier ?? null,
      cwd: metadata.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: sandbox.cli,
      config: { model_reasoning_effort: metadata.effort || DEFAULT_EFFORT },
      excludeTurns: true,
    }, 120_000);
    const forkId = result.thread.id;
    this.loadedThreads.add(forkId);
    this.threadRoots.set(forkId, forkId);
    this.manifest.upsert(forkId, {
      workspaceId: metadata.workspaceId,
      workspaceName: metadata.workspaceName,
      cwd: result.cwd || metadata.cwd,
      mode: metadata.mode,
      model: result.model || metadata.model,
      effort: result.reasoningEffort || metadata.effort,
      serviceTier: Object.hasOwn(result, "serviceTier") ? normalizeServiceTier(result.serviceTier) : metadata.serviceTier ?? null,
      pinned: false,
      title: metadata.title ? `${metadata.title} (fork)` : undefined,
      forkedFromId: sessionId,
    });
    return { sessionId: forkId };
  }

  async review(sessionId, target = { type: "uncommittedChanges" }) {
    return this.#mutate(sessionId, () => this.#review(sessionId, target));
  }

  async #review(sessionId, target) {
    this.#requireSession(sessionId);
    if (this.#runtime(sessionId).activeTurnId) throw httpError(409, "Interrupt the active turn before reviewing");
    await this.#ensureLoaded(sessionId, this.manifest.get(sessionId));
    const eventCursor = this.events.currentIndex(sessionId);
    const owner = {};
    this.pendingReviews.add(owner);
    let result;
    try {
      result = await this.client.request("review/start", { threadId: sessionId, target, delivery: "inline" }, 120_000);
      const childId = result.reviewThreadId || sessionId;
      if (childId !== sessionId) this.threadRoots.set(childId, sessionId);
      const ready = this.reviewMessages.filter(entry => (entry.message.params?.threadId || entry.message.params?.thread?.id) === childId);
      this.reviewMessages = this.reviewMessages.filter(entry => !ready.includes(entry));
      this.reviewBytes -= ready.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of ready) {
        if (entry.kind === "request") this.#guarded("request", entry.message, () => this.#onServerRequest(entry.message));
        else this.#guarded("notification", entry.message, () => this.#onNotification(entry.message));
      }
    } finally {
      this.pendingReviews.delete(owner);
      if (!this.pendingReviews.size) {
        for (const entry of this.reviewMessages) if (entry.kind === "request") this.client.respondError(entry.message.id, -32602, "Unknown panel thread");
        this.reviewMessages = []; this.reviewBytes = 0;
      }
    }
    // A review the App Server delivers on a child thread completes under THAT
    // thread's id. Map it to the root so its notifications route to the panel
    // session and its turn/completed clears the root runtime — otherwise
    // activeTurnId stuck forever and every later send got a 409. The
    // panel streams the ROOT session (that is where the events land), so the
    // root id is what goes back to the caller.
    const reviewThreadId = result.reviewThreadId || sessionId;
    if (reviewThreadId !== sessionId) this.threadRoots.set(reviewThreadId, sessionId);
    this.#acknowledgeTurn(sessionId, reviewThreadId, result.turn, eventCursor);
    return { sessionId, activeThreadId: reviewThreadId, turnId: result.turn.id, eventCursor };
  }

  async runShell(sessionId, command) {
    return this.#mutate(sessionId, () => this.#runShell(sessionId, command));
  }

  async #runShell(sessionId, command) {
    const metadata = this.#requireSession(sessionId);
    if (metadata.mode !== "yolo") throw httpError(409, "Shell mode is available only in YOLO sessions");
    if (this.#runtime(sessionId).activeTurnId) throw httpError(409, "Interrupt or finish the active turn before running a shell command");
    await this.#ensureLoaded(sessionId, metadata);
    await this.client.request("thread/shellCommand", { threadId: sessionId, command }, 120_000);
    return { ok: true };
  }

  async answer(sessionId, requestId, answers) {
    this.#requireSession(sessionId);
    const pending = this.pendingInputs.get(String(requestId));
    if (!pending || pending.sessionId !== sessionId || pending.generation !== this.inputGeneration) throw httpError(404, "Question is no longer pending");
    const normalized = Object.fromEntries(Object.entries(answers || {}).map(([questionId, value]) => [questionId, {
      answers: Array.isArray(value) ? value.map(String) : [String(value)],
    }]));
    if (this.client.respond(pending.id, { answers: normalized }) === false) throw httpError(503, "Codex App Server could not receive the answer; try again");
    this.pendingInputs.delete(String(requestId));
    // The App Server has the real answers above. The replay log and every
    // live subscriber get `[redacted]` for a question the App Server flagged
    // isSecret: nothing renders answer values, and the plaintext used to sit
    // in data/events/<thread>.jsonl, in every reconnect replay and on every
    // other admin's SSE connection.
    // An answer for a question id the pending request did not list is
    // redacted too: its secrecy is unknown, and no consumer needs the value.
    this.#appendSafely(sessionId, "item/tool/requestUserInput/resolved", { requestId, answers: redactSecretAnswers(normalized, pending.params.questions) });
    return { ok: true };
  }

  async archive(sessionId) {
    return this.#mutate(sessionId, () => this.#archive(sessionId));
  }

  async #archive(sessionId) {
    this.#requireSession(sessionId);
    if (this.#runtime(sessionId).activeTurnId) throw httpError(409, "Interrupt the active turn before archiving");
    await this.client.request("thread/archive", { threadId: sessionId });
    this.loadedThreads.delete(sessionId);
    this.manifest.upsert(sessionId, { archived: true });
    this.summaryCache.delete(sessionId);
    return { ok: true };
  }

  async unarchive(sessionId) {
    return this.#mutate(sessionId, () => this.#unarchive(sessionId));
  }

  async #unarchive(sessionId) {
    const metadata = this.#requireSession(sessionId);
    if (!metadata.archived) return { ok: true };
    await this.client.request("thread/unarchive", { threadId: sessionId });
    this.loadedThreads.delete(sessionId);
    this.manifest.upsert(sessionId, { archived: false });
    this.summaryCache.delete(sessionId);
    return { ok: true };
  }

  async deleteSession(sessionId) {
    return this.#mutate(sessionId, () => this.#deleteSession(sessionId));
  }

  async #deleteSession(sessionId) {
    this.#requireSession(sessionId);
    const runtime = this.#runtime(sessionId);
    if (runtime.activeTurnId) await this.client.request("turn/interrupt", { threadId: runtime.activeThreadId || sessionId, turnId: runtime.activeTurnId }).catch(() => undefined);
    try {
      await this.client.request("thread/delete", { threadId: sessionId });
    } catch (error) {
      // The rail already renders a missing native thread as "unavailable"
      // (account swap, ~/.codex cleanup); a failed delete is fatal only when
      // the thread still exists — otherwise the row could never leave the
      // rail.
      if (!isThreadNotFound(error)) {
        try {
          await this.client.request("thread/read", { threadId: sessionId, includeTurns: false });
        } catch (readError) {
          if (!isThreadNotFound(readError)) throw error;
          // A definitive not-found confirms deletion despite the first error.
          return this.#forgetSession(sessionId);
        }
        throw error;
      }
    }
    return this.#forgetSession(sessionId);
  }

  #forgetSession(sessionId) {
    for (const [key, pending] of this.pendingInputs) {
      if (pending.sessionId !== sessionId) continue;
      this.client.respondError(pending.id, -32602, "Panel session was deleted");
      this.pendingInputs.delete(key);
    }
    this.manifest.remove(sessionId);
    this.events.remove(sessionId);
    this.runtime.delete(sessionId);
    this.hydrated.delete(sessionId);
    this.hydrating.delete(sessionId);
    this.runtimeVersions.delete(sessionId);
    for (const [key, value] of this.turnStates) if (value.sessionId === sessionId) this.turnStates.delete(key);
    for (const [key, value] of this.turnDiffs) if (value.sessionId === sessionId) this.turnDiffs.delete(key);
    for (const [threadId, rootId] of this.threadRoots) {
      if (rootId === sessionId) this.threadRoots.delete(threadId);
    }
    this.loadedThreads.delete(sessionId);
    this.summaryCache.delete(sessionId);
    return { ok: true };
  }

  async searchFiles(workspaceId, query) {
    const workspace = workspaceId ? workspaceById(workspaceId) : listWorkspaces()[0];
    if (!workspace) throw httpError(400, "Invalid workspace");
    const result = await this.client.request("fuzzyFileSearch", { query: String(query || ""), roots: [workspace.cwd], cancellationToken: null });
    return { files: (result.files || []).slice(0, 100).map((file) => ({ root: file.root, path: file.path, name: file.file_name, score: file.score, matchType: file.match_type })) };
  }

  async listSkills(sessionId) {
    const metadata = sessionId ? this.#requireSession(sessionId) : null;
    const cwd = metadata?.cwd || listWorkspaces()[0]?.cwd;
    const result = await this.client.request("skills/list", { cwds: cwd ? [cwd] : [], forceReload: false }, 120_000);
    return { skills: (result.data || []).flatMap((entry) => (entry.skills || []).map((skill) => ({ name: skill.name, description: skill.description, scope: skill.scope, enabled: skill.enabled, path: skill.path }))) };
  }

  async listMcp(sessionId) {
    if (sessionId) this.#requireSession(sessionId);
    const result = await this.client.request("mcpServerStatus/list", { cursor: null, limit: 100, detail: "toolsAndAuthOnly", threadId: sessionId || null }, 120_000);
    return { servers: (result.data || []).map((server) => ({
      name: server.name,
      authStatus: server.authStatus,
      serverInfo: server.serverInfo,
      tools: Object.values(server.tools || {}).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
    })) };
  }

  async getDoctor(sessionId) {
    const metadata = sessionId ? this.#requireSession(sessionId) : null;
    const { stdout } = await execFileAsync(CODEX_BIN, ["doctor", "--json"], { cwd: metadata?.cwd || listWorkspaces()[0]?.cwd, maxBuffer: 5 * 1024 * 1024, timeout: 60_000 });
    return { doctor: JSON.parse(stdout), bridge: { ready: this.client.ready, activeSessions: [...this.runtime.values()].filter((runtime) => runtime.activeTurnId).length, warnings: this.warnings.slice(-10) } };
  }

  async exportSession(sessionId) {
    this.#requireSession(sessionId);
    const { thread } = await this.client.request("thread/read", { threadId: sessionId, includeTurns: false });
    const turns = await this.#readAllTurns(sessionId);
    const { threads: descendants } = await this.#getDescendants(sessionId, { full: true });
    return { filename: `${safeFilename(thread.name || thread.preview || "codex-session")}.md`, content: exportThreadMarkdown({ ...thread, turns }, descendants) };
  }

  // Gap-free replay→live handoff: live events arriving during the streamed
  // replay buffer until the file is drained, then flush in idx order. The
  // replay awaits the listener so a slow SSE socket applies backpressure to
  // the file read instead of buffering the whole log in memory. Events that a
  // concurrent compaction diverted before this subscription attached are
  // yielded by streamAfter itself, so the union of file + diverted +
  // live buffer is complete. A listener that returns false reports a gone
  // client: the replay stops and the subscription is released instead of
  // streaming the rest of the log into a dead socket.
  async subscribe(sessionId, after, listener, { onError = () => undefined } = {}) {
    this.#requireSession(sessionId);
    const buffer = [];
    let bytes = 0;
    let stopped = false;
    let failure = null;
    let replaying = true;
    let draining = false;
    let last = after;
    let detach = () => undefined;
    const unsubscribe = () => { stopped = true; buffer.length = 0; bytes = 0; detach(); };
    const fail = error => { failure = error; unsubscribe(); onError(error); };
    const drain = async () => {
      if (draining || stopped) return;
      draining = true;
      try {
        while (buffer.length && !stopped) {
          const { event, size } = buffer.shift(); bytes -= size;
          if (event.idx <= last) continue;
          if (await listener(event) === false) { unsubscribe(); break; }
          last = event.idx;
        }
      } catch (error) { fail(error); }
      finally { draining = false; }
    };
    const live = event => {
      if (stopped) return;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > LIVE_EVENTS_MAX_BYTES) { fail(new Error("Codex event subscriber fell behind; reconnect from the last received cursor")); return; }
      buffer.push({ event, size }); bytes += size;
      if (!replaying) void drain();
    };
    const detachLive = this.events.subscribe(sessionId, live);
    // A recorded handler/storage failure for this session ends the
    // subscription; the client resyncs from its last cursor.
    const onSessionFailure = (error) => fail(error);
    this.events.on(`fail:${sessionId}`, onSessionFailure);
    detach = () => { detachLive(); this.events.off(`fail:${sessionId}`, onSessionFailure); };
    try {
      for await (const event of this.events.streamAfter(sessionId, after)) {
        if (stopped) break;
        if (await listener(event) === false) { unsubscribe(); return unsubscribe; }
        last = event.idx;
      }
      replaying = false;
      await drain();
      if (failure) throw failure;
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  async shutdown() { await this.client.stop(); }

  async #validateSettings(model, effort, serviceTier, mode) {
    if (!new Set(["read-only", "yolo"]).has(mode)) throw httpError(400, "Mode must be read-only or yolo");
    const models = await this.getModels();
    const found = models.find((entry) => entry.id === model);
    if (!found) throw httpError(400, `Unsupported Codex model: ${model}`);
    const efforts = found.supportedReasoningEfforts.map((entry) => entry.id);
    if (effort && !efforts.includes(effort)) throw httpError(400, `${model} does not support ${effort} reasoning`);
    const tiers = found.serviceTiers.map((entry) => entry.id);
    if (serviceTier && !tiers.includes(serviceTier)) throw httpError(400, `${model} does not support service tier ${serviceTier}`);
  }

  async #ensureLoaded(sessionId, metadata) {
    if (this.loadedThreads.has(sessionId)) return;
    const sandbox = modeToSandbox(metadata.mode || DEFAULT_MODE);
    await this.client.request("thread/resume", {
      threadId: sessionId,
      model: metadata.model || DEFAULT_MODEL,
      serviceTier: metadata.serviceTier ?? null,
      cwd: metadata.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: sandbox.cli,
      config: { model_reasoning_effort: metadata.effort || DEFAULT_EFFORT },
      excludeTurns: true,
    }, 120_000);
    this.loadedThreads.add(sessionId);
    this.threadRoots.set(sessionId, sessionId);
  }

  async #applySettings(sessionId, settings) {
    const sandbox = modeToSandbox(settings.mode);
    const serviceTier = normalizeServiceTier(settings.serviceTier);
    const version = this.#runtimeVersion(sessionId, "settings");
    const patch = {
      threadId: sessionId,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: sandbox.policy,
      model: settings.model,
      serviceTier,
      effort: settings.effort,
    };
    await this.client.request("thread/settings/update", patch);
    // The native notification may arrive before the empty RPC acknowledgement.
    // Use its acknowledged values when available; otherwise seed the successful
    // request so an older runtime.settings snapshot cannot undo the Apply.
    if (version === this.#runtimeVersion(sessionId, "settings")) {
      const { threadId, ...applied } = patch;
      this.#setRuntimeField(sessionId, "settings", { ...this.#runtime(sessionId).settings, ...applied });
    }
    this.manifest.upsert(sessionId, { ...settings, serviceTier, ...metadataFromSettings(this.#runtime(sessionId).settings) });
    this.summaryCache.delete(sessionId);
  }

  // Newest `limit` turns of a thread in ascending order, plus how many exist.
  // The first page carries full items; when more turns exist, shell pages
  // count them so turnWindow can say what was withheld. The deprecated
  // full-history read stays as the fallback for a thread the App Server
  // cannot page (before its first user message, or a CLI without
  // thread/turns/list).
  async #readTurnWindow(threadId, limit) {
    let page;
    try {
      page = await this.client.request("thread/turns/list", { threadId, cursor: null, limit, sortDirection: "desc", itemsView: "full" });
    } catch (error) {
      return this.#readTurnsLegacy(threadId, limit, error);
    }
    const turns = (Array.isArray(page?.data) ? [...page.data] : []).reverse();
    let total = turns.length;
    let cursor = page?.nextCursor || null;
    const cursors = new Set();
    for (let pages = 0; cursor && pages < MAX_TURN_COUNT_PAGES; pages += 1) {
      if (cursors.has(cursor)) throw new Error("Codex turn pagination repeated a cursor");
      cursors.add(cursor);
      const shells = await this.client.request("thread/turns/list", { threadId, cursor, limit: TURN_COUNT_PAGE_SIZE, sortDirection: "desc", itemsView: "notLoaded" });
      total += Array.isArray(shells?.data) ? shells.data.length : 0;
      cursor = shells?.nextCursor || null;
    }
    return { turns, total };
  }

  // Every turn of a thread (export). A failure after the first page is thrown
  // — an export must fail visibly rather than ship a partial history.
  async #readAllTurns(threadId) {
    const turns = [];
    const cursors = new Set();
    let cursor = null;
    try {
      do {
        const page = await this.client.request("thread/turns/list", { threadId, cursor, limit: TURN_PAGE_SIZE, sortDirection: "asc", itemsView: "full" });
        turns.push(...(Array.isArray(page?.data) ? page.data : []));
        cursor = page?.nextCursor || null;
        if (cursor && cursors.has(cursor)) throw new Error("Codex turn pagination repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      if (turns.length || cursors.size) throw error;
      return (await this.#readTurnsLegacy(threadId, Infinity, error)).turns;
    }
    return turns;
  }

  async #readTurnsLegacy(threadId, limit, cause) {
    console.warn(`[panel] thread/turns/list unavailable for ${threadId} (${cause instanceof Error ? cause.message : String(cause)}); reading the full history with thread/read`);
    const { thread } = await this.client.request("thread/read", { threadId, includeTurns: true });
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    return { turns: limit === Infinity ? turns : turns.slice(-limit), total: turns.length };
  }

  // Descendant threads. Screen reads (`full` false) list every page by
  // recency, read only the newest DESCENDANT_THREAD_LIMIT threads with a
  // shallow turn window each, and report the thread count withheld; exports
  // read every thread and every turn and rethrow any failure. The listed
  // Thread object is the metadata (the same object thread/read returns
  // without turns); turns come from the paged read.
  async #getDescendants(sessionId, { full = false, descendantLimit = DEFAULT_DESCENDANT_TURN_LIMIT } = {}) {
    const listed = new Map();
    try {
      const cursors = new Set();
      let cursor = null;
      for (let pages = 0; ; pages += 1) {
        const page = await this.client.request("thread/list", { cursor, limit: 100, ancestorThreadId: sessionId, sourceKinds: DESCENDANT_SOURCE_KINDS, sortKey: "recency_at", sortDirection: "desc" });
        let added = 0;
        for (const thread of page?.data || []) {
          if (!thread?.id || listed.has(thread.id)) continue;
          listed.set(thread.id, thread);
          added += 1;
        }
        cursor = page?.nextCursor || null;
        if (!cursor) break;
        if (cursors.has(cursor) || !added) {
          // A page that repeats itself: an export cannot claim completeness;
          // a screen read stops with a floor for the total.
          if (full) throw new Error("Codex descendant pagination repeated a cursor");
          break;
        }
        cursors.add(cursor);
        if (!full && pages + 1 >= MAX_DESCENDANT_LIST_PAGES) break;
      }
    } catch (error) {
      if (full) throw error;
      // The session still opens; the missing subagent list is not silent.
      this.#rememberWarning(`Codex subagent threads for ${sessionId} could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      return { threads: [], threadTotal: 0, turnTotal: 0 };
    }
    // Newest first for the screen slice (the App Server sorts by recency_at;
    // the local sort keeps that true for a server that ignores sortKey).
    const byRecency = (thread) => thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt ?? 0;
    const ordered = [...listed.values()].sort((a, b) => byRecency(b) - byRecency(a));
    const candidates = full ? ordered : ordered.slice(0, DESCENDANT_THREAD_LIMIT);
    const threads = [];
    let turnTotal = 0;
    // Keep fan-out bounded even with thousands of descendant threads.
    for (let offset = 0; offset < candidates.length; offset += 10) {
      const reads = await Promise.allSettled(candidates.slice(offset, offset + 10).map(async (thread) => {
        if (full) return { thread: { ...thread, turns: await this.#readAllTurns(thread.id) }, total: null };
        const window = await this.#readTurnWindow(thread.id, descendantLimit);
        return { thread: { ...thread, turns: window.turns }, total: window.total };
      }));
      for (const result of reads) {
        if (result.status === "fulfilled") {
          threads.push(result.value.thread);
          turnTotal += result.value.total ?? result.value.thread.turns.length;
        } else if (full) throw result.reason;
        else this.#rememberWarning(`Codex subagent thread for ${sessionId} could not be read: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    // Oldest first on the wire, as before.
    threads.sort((a, b) => byRecency(a) - byRecency(b));
    return { threads, threadTotal: listed.size, turnTotal };
  }

  #onNotification(message) {
    const { method, params: nativeParams = {} } = message;
    const params = method === "serverRequest/resolved" && nativeParams.requestId !== undefined
      ? { ...nativeParams, requestId: this.#inputKey(nativeParams.requestId) } : nativeParams;
    if (method === "configWarning" || method === "warning") this.#rememberWarning(params.summary || params.message || method);
    if (method === "serverRequest/resolved" && params.requestId !== undefined) this.pendingInputs.delete(String(params.requestId));

    const thread = params.thread;
    const threadId = params.threadId || thread?.id || null;
    if (method === "thread/started" && threadId) {
      const parentId = thread?.parentThreadId;
      const root = parentId ? (this.threadRoots.get(parentId) || (this.manifest.has(parentId) ? parentId : null)) : (this.manifest.has(threadId) ? threadId : null);
      if (root) this.threadRoots.set(threadId, root);
    }
    const rootId = threadId ? (this.threadRoots.get(threadId) || (this.manifest.has(threadId) ? threadId : null)) : null;
    if (!rootId) {
      if (this.pendingReviews.size && threadId) this.#bufferReviewMessage("notification", message);
      return;
    }

    if (method === "thread/closed") this.loadedThreads.delete(threadId);

    const runtime = this.#runtime(rootId);
    // A turn completes the ROOT session when it is the root's own turn, or a
    // child-thread turn the root is waiting on (an inline review delivered on
    // a review thread — see review()). Descendant subagent turns never match.
    const completesRootTurn = method === "turn/completed"
      && (runtime.activeTurnId
        ? params.turn?.id === runtime.activeTurnId && threadId === (runtime.activeThreadId || rootId)
        : threadId === rootId);
    // Interim cumulative snapshots persist as tiny stubs (idx continuity on
    // disk, full payload live-only); the final diff of a completing turn is
    // written as a real line just before its completion event so replays of
    // finished turns keep their diff.
    const diffKey = `${threadId}:${params.turnId || params.turn?.id}`;
    if (method === "turn/diff/updated") this.turnDiffs.set(diffKey, { sessionId: rootId, params });
    if (method === "turn/completed") {
      const finalDiff = this.turnDiffs.get(diffKey)?.params;
      if (finalDiff?.diff) this.#appendSafely(rootId, "turn/diff/updated", finalDiff);
      this.turnDiffs.delete(diffKey);
    }
    // A failed append returns null (recorded by #appendSafely); the runtime
    // transitions below still run so a storage failure cannot leave a turn
    // "running" forever (every later send would 409 until a restart).
    const event = method === "turn/diff/updated"
      ? this.#appendSafely(rootId, method, params, { persistParams: { stub: true, threadId: params.threadId ?? rootId, turnId: params.turnId ?? null } })
      : this.#appendSafely(rootId, method, params, { retainSnapshot: DURABLE_SNAPSHOT_METHODS.has(method) });
    if ((method === "turn/started" || method === "turn/completed") && params.turn?.id) {
      const key = `${threadId}:${params.turn.id}`;
      this.turnStates.delete(key);
      this.turnStates.set(key, { sessionId: rootId, threadId, turn: { id: params.turn.id, error: params.turn.error, status: params.turn.status || (method === "turn/started" ? "inProgress" : "completed") }, idx: event?.idx ?? null });
      if (this.turnStates.size > 1024) this.turnStates.delete(this.turnStates.keys().next().value);
    }
    this.summaryCache.delete(rootId);
    if (method === "turn/started" && threadId === rootId) {
      runtime.activeTurnId = params.turn?.id ?? null;
      runtime.activeThreadId = threadId;
      // null when the append failed: #acknowledgeTurn's `eventCursor + 1`
      // fallback then names the idx the next successful append will take.
      runtime.activeTurnStartIdx = event?.idx ?? null;
      runtime.status = "running";
      runtime.turnDiff = null;
      this.#setRuntimeField(rootId, "plan", null);
    } else if (completesRootTurn) {
      runtime.status = params.turn?.status || "idle";
      runtime.activeTurnId = null;
      runtime.activeThreadId = null;
      runtime.activeTurnStartIdx = null;
      runtime.turnDiff = null;
      this.manifest.upsert(rootId, { lastError: params.turn?.error?.message || null });
      setImmediate(() => {
        void this.events.compactCompleted(rootId).then((result) => {
          if (result?.error) this.#rememberWarning(`Event-log compaction failed for ${rootId}: ${result.error}`);
        }).catch(error => this.#rememberWarning(`Event-log compaction failed for ${rootId}: ${error.message}`));
      });
    } else if (method === "turn/diff/updated" && (threadId === rootId || threadId === runtime.activeThreadId)) {
      runtime.turnDiff = { threadId, turnId: params.turnId ?? null, diff: String(params.diff ?? "") };
    } else if (method === "thread/goal/updated" && threadId === rootId) {
      this.#setRuntimeField(rootId, "goal", params);
    } else if (method === "thread/goal/cleared" && threadId === rootId) {
      this.#setRuntimeField(rootId, "goal", null);
    } else if (method === "thread/settings/updated" && threadId === rootId) {
      const settings = params.threadSettings || {};
      this.#setRuntimeField(rootId, "settings", settings);
      // Only the keys the notification actually carries: PanelManifest.upsert
      // spreads the patch, so an absent field written as `undefined` erased
      // the stored effort/cwd and sandboxToMode(undefined) flipped a YOLO
      // session to read-only. The App Server names effort
      // `reasoningEffort` in its other responses — accept both spellings.
      this.manifest.upsert(rootId, metadataFromSettings(settings));
    } else if (method === "thread/tokenUsage/updated" && threadId === rootId) this.#setRuntimeField(rootId, "tokenUsage", params.tokenUsage);
    else if (method === "turn/plan/updated" && (threadId === rootId || threadId === runtime.activeThreadId)) this.#setRuntimeField(rootId, "plan", { threadId, turnId: params.turnId ?? null, explanation: params.explanation, steps: params.plan || [] });
    else if (method === "thread/name/updated" && threadId === rootId) {
      this.#bumpRuntimeVersion(rootId, "title");
      this.manifest.upsert(rootId, { title: params.threadName });
    }
  }

  #onServerRequest(message) {
    const { id, method, params = {} } = message;
    if (method === "currentTime/read") {
      this.client.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const rootId = this.threadRoots.get(params.threadId) || (this.manifest.has(params.threadId) ? params.threadId : null);
      if (!rootId) {
        if (this.pendingReviews.size && params.threadId) this.#bufferReviewMessage("request", message);
        else this.client.respondError(id, -32602, "Unknown panel thread");
        return;
      }
      const requestId = this.#inputKey(id);
      const normalized = { ...params, questions: (params.questions || []).map(question => ({ isOther: false, isSecret: false, options: null, ...question })) };
      this.pendingInputs.set(requestId, { id, sessionId: rootId, params: normalized, generation: this.inputGeneration });
      // The question stays answerable even if its event is lost: the polled
      // status carries pendingQuestions.
      this.#appendSafely(rootId, method, { ...normalized, requestId });
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.client.respond(id, { decision: "decline" });
      this.#recordAutoDecline(params.threadId, method);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.client.respond(id, { permissions: {}, scope: "turn", strictAutoReview: false });
      this.#recordAutoDecline(params.threadId, method);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.client.respond(id, { action: "decline", content: null, _meta: null });
      this.#recordAutoDecline(params.threadId, method);
      return;
    }
    this.client.respondError(id, -32601, `Unsupported App Server request: ${method}`);
  }

  #recordAutoDecline(threadId, method) {
    const rootId = this.threadRoots.get(threadId) || (this.manifest.has(threadId) ? threadId : null);
    if (rootId) this.#appendSafely(rootId, "bridge/approvalAutoDeclined", { requestMethod: method, message: "Approval request declined because panel sessions never prompt for permissions." });
  }

  #onClientExit(error) {
    this.loadedThreads.clear();
    this.threadRoots.clear();
    this.reviewMessages = []; this.reviewBytes = 0;
    for (const { sessionId, params } of this.turnDiffs.values()) {
      if (this.manifest.has(sessionId) && params.diff) this.#appendSafely(sessionId, "turn/diff/updated", params);
    }
    this.turnDiffs.clear();
    for (const [requestId, pending] of this.pendingInputs) {
      this.#appendSafely(pending.sessionId, "item/tool/requestUserInput/resolved", { requestId, cancelled: true, reason: "App Server exited" });
    }
    this.pendingInputs.clear();
    this.inputGeneration = randomUUID();
    const interrupted = new Map([...this.turnStates].filter(([, state]) => state.turn.status === "inProgress" && state.sessionId && this.manifest.has(state.sessionId)));
    for (const [sessionId, runtime] of this.runtime) if (runtime.activeTurnId) {
      const threadId = runtime.activeThreadId || sessionId;
      interrupted.set(`${threadId}:${runtime.activeTurnId}`, { sessionId, threadId, turn: { id: runtime.activeTurnId } });
    }
    for (const [key, { sessionId, threadId, turn }] of interrupted) {
      const terminal = { id: turn.id, status: "interrupted", items: [], itemsView: "notLoaded", error: null };
      this.#appendSafely(sessionId, "bridge/restarted", { threadId, turnId: turn.id, message: error.message });
      this.#appendSafely(sessionId, "turn/completed", { threadId, turn: terminal });
      this.turnStates.set(key, { sessionId, threadId, turn: { id: turn.id, status: "interrupted" } });
    }
    for (const [sessionId, runtime] of this.runtime) {
      if (!runtime.activeTurnId) continue;
      runtime.turnDiff = null;
      runtime.activeTurnId = null;
      runtime.activeThreadId = null;
      runtime.activeTurnStartIdx = null;
      runtime.status = "interrupted";
      this.summaryCache.delete(sessionId);
      // The runtime is already reset above; a manifest write failure must not
      // skip the remaining sessions.
      try { this.manifest.upsert(sessionId, { lastError: error.message }); }
      catch (writeError) { this.#recordStorageFailure(sessionId, "manifest", writeError); }
    }
  }

  // Error boundary for emitter-driven handlers.
  // The failure is recorded — journal, /v2/status warning, the session's
  // lastError — and only that session's subscribers are closed (they resync
  // from their cursor); the process and every other session carry on. A
  // deterministic cause (a persistently full disk, a corrupt latest-snapshot
  // file) is thereby a visible per-session fault instead of a crash loop.
  #guarded(kind, message, handler) {
    try { return handler(); }
    catch (error) { this.#recordHandlerFailure(kind, message, error); return undefined; }
  }

  #recordHandlerFailure(kind, message, error) {
    const method = message?.method || kind;
    const threadId = message?.params?.threadId || message?.params?.thread?.id || null;
    const sessionId = threadId ? (this.threadRoots.get(threadId) || (this.manifest.has(threadId) ? threadId : null)) : null;
    const text = error instanceof Error ? error.message : String(error);
    console.error(`[panel] ${kind} handler failed (${method}${sessionId ? `, session ${sessionId}` : ""}): ${error instanceof Error ? error.stack || error.message : String(error)}`);
    this.#rememberWarning(`Codex bridge ${kind} handler failed (${method}${sessionId ? ` on ${sessionId}` : ""}): ${text}`);
    if (sessionId) this.#failSession(sessionId, error);
  }

  // Storage failures never abort a handler's state transitions. The event is
  // lost from the replay log (the index advances only after a successful
  // append, so no idx is skipped and cursors stay consistent), the failure is
  // recorded, and the runtime keeps tracking the native turn: transcripts
  // live in the native thread store, the replay log is the live-stream
  // convenience.
  #appendSafely(sessionId, method, params, options) {
    try { return this.events.append(sessionId, method, params, options); }
    catch (error) { this.#recordStorageFailure(sessionId, method, error); return null; }
  }

  #recordStorageFailure(sessionId, method, error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(`[panel] replay-log write failed for ${sessionId} (${method}): ${text}`);
    this.#rememberWarning(`Codex replay log write failed for ${sessionId} (${method}): ${text}`);
    this.#failSession(sessionId, error);
  }

  #failSession(sessionId, error) {
    const text = error instanceof Error ? error.message : String(error);
    try { if (this.manifest.has(sessionId)) this.manifest.upsert(sessionId, { lastError: `Codex bridge storage failure: ${text}` }); }
    catch (writeError) { console.error(`[panel] could not record lastError for ${sessionId}: ${writeError instanceof Error ? writeError.message : String(writeError)}`); }
    this.summaryCache.delete(sessionId);
    this.events.emit(`fail:${sessionId}`, error instanceof Error ? error : new Error(text));
  }

  // Public surface for server.js (stream replay failures, timer callbacks).
  recordWarning(message) { this.#rememberWarning(message); }

  // Uploads a send/steer references must still exist — the reaper may have
  // removed a stale draft's file — and the ones that do are marked consumed
  // so the reaper can release them sooner than a never-sent draft's. Paths
  // outside the upload directory (workspace `@` mentions) are the App
  // Server's to validate.
  #consumeUploads(files) {
    const now = Date.now();
    for (const file of files) {
      if (!file?.path || !this.#isUploadPath(file.path)) continue;
      if (!existsSync(file.path)) {
        throw httpError(400, `Attachment "${file.name || basename(file.path)}" is no longer available (uploads not sent within ${UPLOAD_DRAFT_TTL_MS / 3600_000} hours are removed) — attach it again`);
      }
      this.consumedUploads.set(resolve(file.path), now);
      if (this.consumedUploads.size > CONSUMED_UPLOADS_MAX) this.consumedUploads.delete(this.consumedUploads.keys().next().value);
    }
  }

  #isUploadPath(path) { return resolve(String(path)).startsWith(this.uploadDir + sep); }

  uploadConsumedAt(path) { return this.consumedUploads.get(resolve(String(path))) ?? null; }

  #runtime(sessionId) {
    if (!this.runtime.has(sessionId)) this.runtime.set(sessionId, { status: "idle", activeTurnId: null, activeThreadId: null, activeTurnStartIdx: null, settings: null, tokenUsage: null, plan: null, turnDiff: null, goal: null });
    return this.runtime.get(sessionId);
  }

  #bufferReviewMessage(kind, message) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.reviewBytes + bytes > LIVE_EVENTS_MAX_BYTES) {
      this.#rememberWarning("Early review output exceeded the replay window; refresh the session to load its native history");
      if (kind === "request") this.client.respondError(message.id, -32602, "Review replay window exceeded");
      // Terminal state must still win over a late review/start response even
      // when the compatibility replay window is full.
      if (message.method === "turn/completed" && message.params?.turn?.id) {
        this.turnStates.set(`${message.params.threadId}:${message.params.turn.id}`, { sessionId: null, threadId: message.params.threadId, turn: { id: message.params.turn.id, status: message.params.turn.status || "completed", error: message.params.turn.error } });
        if (this.turnStates.size > 1024) this.turnStates.delete(this.turnStates.keys().next().value);
      }
      return;
    }
    this.reviewMessages.push({ kind, message, bytes });
    this.reviewBytes += bytes;
  }

  async #mutate(sessionId, operation) {
    // Serialize acknowledgements, not model turns. Settings remain available
    // throughout a running turn, while overlapping sends and patches cannot
    // both inspect the same idle/settings state and later overwrite each other.
    const previous = this.mutations.get(sessionId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => { this.#requireSession(sessionId); return operation(); });
    this.mutations.set(sessionId, pending);
    try { return await pending; }
    finally { if (this.mutations.get(sessionId) === pending) this.mutations.delete(sessionId); }
  }

  #acknowledgeTurn(sessionId, threadId, turn, eventCursor) {
    this.#requireSession(sessionId);
    const runtime = this.#runtime(sessionId);
    const observed = this.turnStates.get(`${threadId}:${turn.id}`)?.turn || turn;
    if (observed.status && observed.status !== "inProgress") {
      if (!runtime.activeTurnId || runtime.activeTurnId === turn.id) {
        runtime.activeTurnId = null;
        runtime.activeThreadId = null;
        runtime.activeTurnStartIdx = null;
        runtime.status = observed.status;
      }
      return;
    }
    // A newer autonomous turn may already have started before this response.
    if (runtime.activeTurnId && runtime.activeTurnId !== turn.id) return;
    runtime.activeTurnId = turn.id;
    runtime.activeThreadId = threadId;
    runtime.activeTurnStartIdx ??= eventCursor + 1;
    runtime.status = "running";
    if (runtime.plan?.turnId !== turn.id || runtime.plan?.threadId !== threadId) this.#setRuntimeField(sessionId, "plan", null);
    const diff = this.turnDiffs.get(`${threadId}:${turn.id}`)?.params;
    if (diff) runtime.turnDiff = { threadId, turnId: turn.id, diff: String(diff.diff || "") };
    this.summaryCache.delete(sessionId);
  }

  #runtimeVersion(sessionId, field) { return this.runtimeVersions.get(sessionId)?.[field] || 0; }

  #setRuntimeField(sessionId, field, value) {
    this.#runtime(sessionId)[field] = value;
    this.#bumpRuntimeVersion(sessionId, field);
  }

  #bumpRuntimeVersion(sessionId, field) {
    const versions = this.runtimeVersions.get(sessionId) || {};
    versions[field] = (versions[field] || 0) + 1;
    this.runtimeVersions.set(sessionId, versions);
  }

  async #hydrateRuntime(sessionId) {
    if (this.hydrated.has(sessionId)) return;
    if (this.hydrating.has(sessionId)) return this.hydrating.get(sessionId);
    const runtime = this.#runtime(sessionId);
    const versions = { ...this.runtimeVersions.get(sessionId) };
    const unchanged = field => !(versions[field] > 0) && this.runtime.get(sessionId) === runtime && this.#runtimeVersion(sessionId, field) === 0;
    const hydrate = async () => {
      const snapshots = await this.events.readRuntimeSnapshots(sessionId);
      // Older releases persisted goal/usage/plan as replay-invisible stubs.
      // Goals have an official persisted-state getter; tolerate older native
      // versions without it, and never overwrite a notification received while
      // this getter was pending (including clear -> null).
      if (!Object.hasOwn(snapshots, "goal") && !(versions.goal > 0)) {
        try {
          const result = await this.client.request("thread/goal/get", { threadId: sessionId });
          snapshots.goal = result.goal ? { threadId: sessionId, goal: result.goal } : null;
        } catch { /* Optional getter unavailable: retain any live state. */ }
      }
      for (const [field, value] of Object.entries(snapshots)) if (unchanged(field)) runtime[field] = value;
      if (this.runtime.get(sessionId) === runtime) this.hydrated.add(sessionId);
    };
    const pending = hydrate();
    this.hydrating.set(sessionId, pending);
    try { await pending; }
    finally { if (this.hydrating.get(sessionId) === pending) this.hydrating.delete(sessionId); }
  }

  #requireSession(sessionId) {
    let metadata = this.manifest.get(sessionId);
    if (!metadata) throw httpError(404, "Codex session not found");
    if (metadata.serviceTier === "default") metadata = this.manifest.upsert(sessionId, { serviceTier: null });
    return metadata;
  }

  #pendingForSession(sessionId) {
    return [...this.pendingInputs.entries()].filter(([, pending]) => pending.sessionId === sessionId).map(([requestId, pending]) => ({ requestId, ...pending.params }));
  }

  #inputKey(id) { return `${this.inputGeneration}:${id}`; }

  #rememberWarning(message) {
    const text = String(message || "").trim();
    if (!text || this.warnings.includes(text)) return;
    this.warnings.push(text);
    if (this.warnings.length > 30) this.warnings.shift();
  }
}

function extractCliVersion(userAgent) {
  const match = String(userAgent || "").match(/\/(\d+\.\d+\.\d+)/);
  return match?.[1] || "unknown";
}

function safeFilename(value) { return String(value || "codex-session").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "codex-session"; }
function normalizeServiceTier(value) { return value === "default" || value == null ? null : value; }

function preferredEffort(model) {
  return model?.supportedReasoningEfforts.some(entry => entry.id === DEFAULT_EFFORT) ? DEFAULT_EFFORT : model?.defaultReasoningEffort || model?.supportedReasoningEfforts[0]?.id;
}

function metadataFromSettings(settings = {}) {
  const sandbox = settings.sandboxPolicy ?? settings.sandbox;
  const effort = Object.hasOwn(settings, "effort") ? settings.effort : settings.reasoningEffort;
  return {
    ...(sandbox !== undefined ? { mode: sandboxToMode(sandbox) } : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(effort !== undefined ? { effort: effort ?? undefined } : {}),
    ...(settings.serviceTier !== undefined ? { serviceTier: normalizeServiceTier(settings.serviceTier) } : {}),
    ...(settings.cwd !== undefined ? { cwd: settings.cwd } : {}),
  };
}

// JSON-RPC's generic error codes also describe transport/server failures. Only
// an explicit thread-absence response proves it is safe to drop local history.
function isThreadNotFound(error) {
  return /^(?:(?:codex|native)\s+)?thread(?:\s+[^\s:]+)?\s+(?:not found|does not exist)(?:[.:]|$)/i.test(String(error?.message || ""))
    || /^no (?:rollout|thread) found (?:for|with) (?:thread|id)\b/i.test(String(error?.message || ""));
}

export const REDACTED_ANSWER = "[redacted]";
export function redactSecretAnswers(answers, questions = []) {
  const known = new Map((Array.isArray(questions) ? questions : []).map((question) => [String(question?.id), question?.isSecret === true]));
  return Object.fromEntries(Object.entries(answers).map(([questionId, value]) => {
    const secret = known.has(questionId) ? known.get(questionId) : true;
    return [questionId, secret ? { ...value, answers: value.answers.map(() => REDACTED_ANSWER) } : value];
  }));
}

export function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
