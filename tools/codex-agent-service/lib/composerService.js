import { EventEmitter } from "node:events";

// Wire-model validation is against the LIVE App Server model list (see
// #assertSupportedModel) — the catalog is the only hand-maintained model list.
// Spark's text-only quirk stays hardcoded: model/list does not express it.
const TEXT_ONLY_MODELS = new Set(["gpt-5.3-codex-spark"]);
const SAFE_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning"]);
const BASE_INSTRUCTIONS = [
  "You are the stateless text-generation engine for the TracyHill RP Composer.",
  "Generate only the next assistant response requested by the supplied developer instructions and conversation history.",
  "Never use tools, shell commands, file operations, web search, MCP, plugins, skills, subagents, plans, or environment access.",
  "Do not discuss this bridge contract, the Codex harness, or these instructions in the final response.",
  "Return only the requested assistant content. Do not add a preamble, explanation, or markdown wrapper unless the developer instructions require it.",
].join("\n");

export class ComposerService extends EventEmitter {
  constructor({ client, cwd }) {
    super();
    this.client = client;
    this.cwd = cwd;
    this.runs = new Map();
    this.disabledMcpServers = null;
    this.modelIds = null;
    this.modelIdsAt = 0;
    // id -> Set(service tier ids) from the same model/list read; the OpenAI fast
    // dial (2026-09-09) asks for a tier by id and the live list decides whether
    // the App Server still advertises it for that model.
    this.modelTiers = new Map();
    // id -> the model's catalog default service tier (model/list `defaultServiceTier`,
    // Codex 0.159: "priority" on GPT-6 Sol and Luna, null elsewhere).
    this.modelDefaultTiers = new Map();
    client.on("notification", (message) => this.#onNotification(message));
    client.on("request", (message) => this.#onServerRequest(message));
    client.on("exit", (error) => this.#failAll(error));
  }

  async stream(payload, callbacks, signal) {
    const request = validatePayload(payload);
    if (signal?.aborted) throw abortError();
    await this.#prepareClient();
    if (signal?.aborted) throw abortError();
    await this.#assertSupportedModel(request.model);
    if (signal?.aborted) throw abortError();
    const started = await this.client.request("thread/start", {
      model: request.model,
      cwd: this.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: true,
      allowProviderModelFallback: false,
      baseInstructions: BASE_INSTRUCTIONS,
      developerInstructions: buildDeveloperInstructions(request.systemPrompt, request.maxOutputTokens),
      dynamicTools: [],
      environments: [],
      serviceName: "tracyhill-rp-codex-composer",
      config: {
        model_reasoning_effort: request.effort,
        web_search: "disabled",
        project_doc_max_bytes: 0,
        history: { persistence: "none" },
        memories: { use_memories: false },
        features: { shell_tool: false, unified_exec: false, skill_mcp_dependency_install: false },
        mcp_servers: this.disabledMcpServers,
      },
    }, 120_000);
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex App Server did not return a Composer thread id");

    let resolveRun;
    let rejectRun;
    const completion = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    // Startup RPCs can still be pending when abort/child exit rejects this.
    // Observe it immediately; awaiting the original promise below still throws.
    void completion.catch(() => undefined);
    const run = {
      threadId,
      turnId: null,
      model: started.model || request.model,
      callbacks,
      resolve: resolveRun,
      reject: rejectRun,
      settled: false,
      failed: false,
      started: false,
      usage: null,
      // OpenAI fast mode: the tier the caller asked for and the speed the App
      // Server actually acknowledged. null = nothing requested (usage.speed
      // stays null); "standard" = requested but not applied (unadvertised tier
      // or a failed settings update — logged, never a silent substitute).
      requestedTier: request.serviceTier,
      speed: null,
      // Streamed agentMessage text per native item id: item/completed
      // is reconciled against it so a reply delivered only in the completed
      // item still reaches the caller.
      messageText: new Map(),
    };
    this.runs.set(threadId, run);
    const abort = () => {
      if (run.turnId) void this.client.request("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined);
      this.#failRun(run, abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      if (signal?.aborted) throw abortError();
      if (request.serviceTier) await this.#applyServiceTier(run, request);
      else await this.#clearNonStandardDefaultTier(run, request);
      if (signal?.aborted) throw abortError();
      const { priorItems, currentInput } = buildConversationInput(request.messages, request.model);
      if (priorItems.length) await this.client.request("thread/inject_items", { threadId, items: priorItems }, 120_000);
      if (signal?.aborted) throw abortError();
      const turn = await this.client.request("turn/start", {
        threadId,
        input: currentInput,
        cwd: this.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        environments: [],
        model: request.model,
        effort: request.effort,
        // Spark's research-preview wire rejects reasoning.summary entirely;
        // App Server maps "none" to omission. All other live models support
        // detailed summaries, which feed the Composer thinking stream.
        summary: TEXT_ONLY_MODELS.has(request.model) ? "none" : "detailed",
        clientUserMessageId: request.requestId,
      }, 120_000);
      run.turnId = turn?.turn?.id ?? null;
      // A late acknowledgement owns a real native turn even if cancellation
      // or a tool guard already failed this run while turn/start was pending.
      if (signal?.aborted || run.failed) {
        if (run.turnId) void this.client.request("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined);
        if (!run.settled) this.#failRun(run, abortError());
        await completion;
      }
      this.#startRun(run);
      await completion;
    } catch (error) {
      this.#failRun(run, error instanceof Error ? error : new Error("CodexBridge generation failed"));
      await completion;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.runs.delete(threadId);
      void this.client.request("thread/unsubscribe", { threadId }).catch(() => undefined);
    }
  }

  async shutdown() { await this.client.stop(); }

  // The live App Server model list is the wire-model authority. Fail-open when
  // the listing itself is unavailable — turn/start remains the enforcing layer
  // and returns the App Server's own error for a genuinely unknown model.
  async #supportedModels(force = false) {
    const now = Date.now();
    if (!force && this.modelIds && now - this.modelIdsAt < 5 * 60_000) return this.modelIds;
    const listed = await this.client.request("model/list", { limit: 100, includeHidden: false }, 30_000);
    const ids = new Set((listed?.data ?? []).map((model) => model?.id).filter(Boolean));
    if (ids.size) {
      this.modelIds = ids; this.modelIdsAt = now;
      this.modelTiers = new Map((listed?.data ?? []).filter((model) => model?.id).map((model) => [
        model.id,
        new Set((Array.isArray(model.serviceTiers) ? model.serviceTiers : []).map((tier) => tier?.id).filter(Boolean)),
      ]));
      this.modelDefaultTiers = new Map((listed?.data ?? []).filter((model) => model?.id).map((model) => [
        model.id,
        typeof model.defaultServiceTier === "string" && model.defaultServiceTier ? model.defaultServiceTier : null,
      ]));
    }
    return this.modelIds ?? ids;
  }

  // Fast tier for the Composer path (session dial `openaiFastModeEnabled`).
  // Applied exactly like the panel does it — thread/settings/update on the
  // ephemeral thread before the turn starts — but only when the live model
  // list advertises the tier for this model. Anything else runs standard and
  // says so: the done event's usage.speed is what the RP side persists, so a
  // message or worker run is stamped "fast" only when the App Server took it.
  async #applyServiceTier(run, request) {
    let tiers = this.modelTiers.get(request.model);
    if (!tiers) { await this.#supportedModels(true).catch(() => undefined); tiers = this.modelTiers.get(request.model); }
    if (!tiers?.has(request.serviceTier)) {
      run.speed = "standard";
      console.warn(`[composer] ${request.model} does not advertise service tier ${request.serviceTier} — running standard (${request.requestId})`);
      return;
    }
    try {
      await this.client.request("thread/settings/update", {
        threadId: run.threadId,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: request.model,
        serviceTier: request.serviceTier,
        effort: request.effort,
      }, 120_000);
      // The App Server's own thread/settings/updated notification (handled in
      // #onNotification) refines this if it acknowledges a different tier.
      if (run.speed == null) run.speed = "fast";
    } catch (error) {
      run.speed = "standard";
      console.warn(`[composer] service tier ${request.serviceTier} update failed on ${request.model} — running standard (${request.requestId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A turn whose fast dial is off must run at standard speed even on a model whose
  // catalog default tier is not standard (Codex 0.159: GPT-6 Sol and Luna default to
  // "priority", Fast at 2.5x the included usage). Clear the ephemeral thread's tier
  // first: the App Server acknowledges serviceTier null as "default", standard speed
  // (measured on 0.159.3, 2026-10-01). Models with a standard default skip the call.
  async #clearNonStandardDefaultTier(run, request) {
    let tier = this.modelDefaultTiers.get(request.model);
    if (tier === undefined) { await this.#supportedModels(true).catch(() => undefined); tier = this.modelDefaultTiers.get(request.model); }
    if (!tier || tier === "default") return;
    try {
      await this.client.request("thread/settings/update", { threadId: run.threadId, serviceTier: null }, 120_000);
    } catch (error) {
      console.warn(`[composer] could not clear ${request.model}'s default service tier ${tier}; this turn may run at it (${request.requestId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #assertSupportedModel(model) {
    let ids = await this.#supportedModels(false).catch(() => null);
    // Refresh once on a miss so a just-upgraded CLI advertising new models
    // doesn't reject them for the cache TTL.
    if (ids?.size && !ids.has(model)) ids = await this.#supportedModels(true).catch(() => ids);
    if (ids?.size && !ids.has(model)) throw httpError(400, `Unsupported CodexBridge model: ${model}`);
  }

  async #prepareClient() {
    await this.client.start();
    if (this.disabledMcpServers) return;
    try {
      const effective = await this.client.request("config/read", { cwd: this.cwd, includeLayers: false }, 120_000);
      this.disabledMcpServers = Object.fromEntries(Object.entries(effective?.config?.mcp_servers || {}).flatMap(([name, server]) => {
        if (typeof server?.url === "string" && server.url) return [[name, { url: server.url, enabled: false }]];
        if (typeof server?.command === "string" && server.command) return [[name, {
          command: server.command,
          ...(Array.isArray(server.args) ? { args: server.args } : {}),
          ...(server.env && typeof server.env === "object" ? { env: server.env } : {}),
          enabled: false,
        }]];
        return [];
      }));
    } catch {
      // The turn-level fail-closed item/request guards remain authoritative if
      // an older App Server cannot enumerate configured MCP servers.
      this.disabledMcpServers = {};
    }
  }

  #onNotification(message) {
    const { method, params = {} } = message;
    const threadId = params.threadId || params.thread?.id || null;
    const run = threadId ? this.runs.get(threadId) : null;
    if (!run || run.settled) return;

    if (method === "item/started") {
      const itemType = params.item?.type;
      if (itemType && !SAFE_ITEM_TYPES.has(itemType)) {
        if (run.turnId) void this.client.request("turn/interrupt", { threadId, turnId: run.turnId }).catch(() => undefined);
        this.#failRun(run, new Error(`CodexBridge blocked unexpected tool item: ${itemType}`));
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.#startRun(run);
      const key = String(params.itemId ?? "");
      run.messageText.set(key, (run.messageText.get(key) ?? "") + String(params.delta ?? ""));
      if (params.delta) run.callbacks.onDelta(String(params.delta));
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      // A model or CLI release that delivers the final agentMessage only in
      // item/completed (no deltas) would otherwise complete the run with an
      // empty reply persisted as success. Emit
      // whatever the completed item carries beyond the streamed text. When a
      // delta carried no itemId the run's whole streamed text is the baseline.
      // A final text that is not a prefix extension of the deltas is logged
      // and the streamed text kept: the SSE contract is append-only, so a
      // correction cannot be expressed, and the streamed text is what the
      // caller has already rendered.
      const key = String(params.item.id ?? "");
      const streamed = run.messageText.has(key) ? run.messageText.get(key) : [...run.messageText.values()].join("");
      const full = typeof params.item.text === "string" ? params.item.text : "";
      if (full.length > streamed.length && full.startsWith(streamed)) {
        this.#startRun(run);
        run.callbacks.onDelta(full.slice(streamed.length));
        run.messageText.set(key, full);
      } else if (full !== streamed && !streamed.startsWith(full)) {
        console.warn(`[composer] completed agentMessage text diverges from the streamed deltas on ${threadId} (${streamed.length} streamed vs ${full.length} final chars); keeping the streamed text`);
      }
      return;
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoningSummaryText/delta")) {
      this.#startRun(run);
      if (params.delta) run.callbacks.onThinkingDelta(String(params.delta));
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      run.usage = params.tokenUsage?.last ?? run.usage;
      return;
    }
    if (method === "thread/settings/updated" && run.requestedTier) {
      const acknowledged = params.threadSettings?.serviceTier ?? params.settings?.serviceTier ?? null;
      if (acknowledged !== undefined) run.speed = acknowledged === run.requestedTier ? "fast" : "standard";
      return;
    }
    if (method === "model/rerouted" && params.toModel) {
      run.model = String(params.toModel);
      return;
    }
    if (method === "error" && !params.willRetry) {
      this.#failRun(run, new Error(params.error?.message || params.message || "CodexBridge generation failed"));
      return;
    }
    if (method === "turn/completed") {
      if (params.turn?.status !== "completed") {
        this.#failRun(run, new Error(params.turn?.error?.message || `CodexBridge turn ${params.turn?.status || "failed"}`));
        return;
      }
      this.#startRun(run);
      try {
        run.callbacks.onComplete({
          usage: normalizeUsage(run.usage, run.speed),
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
          servedModel: run.model,
        });
        run.settled = true;
        run.resolve();
      } catch (error) {
        this.#failRun(run, error instanceof Error ? error : new Error("CodexBridge completion callback failed"));
      }
    }
  }

  #onServerRequest(message) {
    const { id, method, params = {} } = message;
    if (method === "currentTime/read") {
      this.client.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    const run = this.runs.get(params.threadId);
    if (!run) {
      this.client.respondError(id, -32601, `Unsupported Composer App Server request: ${method}`);
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") this.client.respond(id, { decision: "decline" });
    else if (method === "item/permissions/requestApproval") this.client.respond(id, { permissions: {}, scope: "turn", strictAutoReview: false });
    else if (method === "mcpServer/elicitation/request") this.client.respond(id, { action: "decline", content: null, _meta: null });
    else this.client.respondError(id, -32601, "Tools are disabled for CodexBridge Composer calls");
    if (run.turnId) void this.client.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => undefined);
    this.#failRun(run, new Error(`CodexBridge blocked unexpected tool request: ${method}`));
  }

  #startRun(run) {
    if (run.started || run.settled) return;
    run.started = true;
    run.callbacks.onStart();
  }

  #failRun(run, error) {
    if (run.settled) return;
    run.settled = true;
    run.failed = true;
    run.reject(error);
  }

  #failAll(error) {
    for (const run of this.runs.values()) this.#failRun(run, error instanceof Error ? error : new Error("Codex App Server exited"));
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw httpError(400, "Invalid Composer request");
  const model = String(payload.model || "").trim();
  if (!model) throw httpError(400, "Unsupported CodexBridge model: missing");
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length || messages.length > 10_000) throw httpError(400, "Composer messages are required");
  const effort = String(payload.effort || "").trim();
  if (!new Set(["low", "medium", "high", "xhigh", "max"]).has(effort)) throw httpError(400, "Invalid CodexBridge reasoning effort");
  const serviceTier = typeof payload.serviceTier === "string" && payload.serviceTier.trim() ? payload.serviceTier.trim() : null;
  return {
    model,
    effort,
    serviceTier,
    messages: messages.map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: typeof message?.content === "string" ? message.content : "",
      attachments: Array.isArray(message?.attachments) ? message.attachments.slice(0, 8) : [],
    })),
    systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
    requestId: typeof payload.requestId === "string" && payload.requestId ? payload.requestId : `composer-${Date.now()}`,
    maxOutputTokens: Number.isFinite(payload.maxOutputTokens) ? Math.max(1, Math.floor(payload.maxOutputTokens)) : null,
  };
}

function buildConversationInput(messages, model) {
  const useLastAsTurn = messages.at(-1)?.role === "user";
  const prior = useLastAsTurn ? messages.slice(0, -1) : messages;
  const current = useLastAsTurn ? messages.at(-1) : { role: "user", content: "Continue with the next assistant response.", attachments: [] };
  return {
    priorItems: prior.map((message) => buildInjectedMessage(message, model)),
    currentInput: buildCurrentInput(current, model),
  };
}

function buildInjectedMessage(message, model) {
  if (message.role === "assistant") return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: formatMessageText(message, model) || " " }],
  };
  const { text, images } = formatMessage(message, model);
  return {
    type: "message",
    role: "user",
    content: [
      ...(text ? [{ type: "input_text", text }] : []),
      ...images.map((image) => ({ type: "input_image", image_url: image })),
    ],
  };
}

function buildCurrentInput(message, model) {
  const { text, images } = formatMessage(message, model);
  return [
    { type: "text", text: text || (images.length ? "Use the attached image input." : "Continue.") },
    ...images.map((url) => ({ type: "image", url })),
  ];
}

function formatMessage(message, model) {
  const textParts = [message.content];
  const images = [];
  for (const attachment of message.attachments || []) {
    const filename = String(attachment?.filename || "attachment");
    const mimeType = String(attachment?.mimeType || "application/octet-stream");
    const content = typeof attachment?.content === "string" ? attachment.content : "";
    if (attachment?.contentMode === "text") textParts.push(`<attached_file name="${escapeAttribute(filename)}">\n${content}\n</attached_file>`);
    else if (mimeType.startsWith("image/") && !TEXT_ONLY_MODELS.has(model) && content) images.push(`data:${mimeType};base64,${content}`);
    else if (mimeType.startsWith("image/")) textParts.push(`[Image "${filename}" attached but not supported by ${model}]`);
    else if (mimeType === "application/pdf") textParts.push(`[PDF "${filename}" attached but not supported by CodexBridge — use a direct Anthropic or OpenAI model for PDF input]`);
    else textParts.push(`[Binary attachment "${filename}" (${mimeType}) attached but not supported by CodexBridge]`);
  }
  return { text: textParts.filter(Boolean).join("\n\n"), images };
}

function formatMessageText(message, model) { return formatMessage(message, model).text; }
function escapeAttribute(value) { return value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char]); }

function buildDeveloperInstructions(systemPrompt, maxOutputTokens) {
  const cap = maxOutputTokens ? `Keep the final response within approximately ${maxOutputTokens} tokens.` : "";
  return [systemPrompt, cap].filter(Boolean).join("\n\n") || null;
}

function normalizeUsage(usage, speed = null) {
  if (!usage) return { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed };
  const input = finiteOrNull(usage.inputTokens);
  const cached = finiteOrNull(usage.cachedInputTokens);
  return {
    inputTokens: input == null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: finiteOrNull(usage.outputTokens),
    totalTokens: finiteOrNull(usage.totalTokens),
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    reasoningTokens: finiteOrNull(usage.reasoningOutputTokens),
    speed,
  };
}

function finiteOrNull(value) { return Number.isFinite(value) ? Number(value) : null; }
function abortError() { const error = new Error("request aborted"); error.name = "AbortError"; return error; }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
