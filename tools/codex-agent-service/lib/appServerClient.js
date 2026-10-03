import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export class AppServerClient extends EventEmitter {
  constructor({ command = "codex", args = ["app-server", "--strict-config"], env = process.env, requestTimeoutMs = 60_000, clientInfo = null } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo || { name: "tracyhill-rp-codex-panel", title: "TracyHill RP Codex Panel", version: "2.0.0" };
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.ready = false;
    this.starting = null;
    this.initializeResult = null;
    this.stderrTail = [];
  }

  async start() {
    if (this.ready && this.proc) return this.initializeResult;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    const proc = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...this.env } });
    this.proc = proc;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => { if (this.proc === proc) this.#onLine(line); });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.emit("stderr", text);
    });
    proc.on("error", (error) => this.#onExit(proc, error));
    proc.on("close", (code, signal) => this.#onExit(proc, new Error(`Codex App Server exited (${signal ?? code ?? "unknown"})`)));
    // A pipe write can fail asynchronously after write() returns. Retire this
    // child through the same recovery path, rejecting every pending RPC once.
    proc.stdin.on("error", (error) => {
      this.#onExit(proc, error);
      try { proc.kill("SIGTERM"); } catch {}
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex App Server failed to start")), 10_000);
      proc.once("spawn", () => { clearTimeout(timer); resolve(); });
      proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    });

    try {
      const result = await this.#requestRaw("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      }, 30_000);
      this.notify("initialized", {});
      this.ready = true;
      this.initializeResult = result;
      this.emit("ready", result);
      return result;
    } catch (error) {
      if (this.proc === proc) {
        this.proc = null;
        try { proc.kill("SIGTERM"); } catch {}
      }
      throw error;
    }
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    await this.start();
    return this.#requestRaw(method, params, timeoutMs);
  }

  #requestRaw(method, params, timeoutMs) {
    if (!this.proc?.stdin.writable) return Promise.reject(new Error("Codex App Server is unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      // A send that throws must not strand its pending entry + timer until
      // the timeout.
      try { this.#send({ method, id, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  // Fire-and-forget sends must never throw into an event handler — a child
  // that died between receiving a server request and our reply would
  // otherwise turn a routine respond() into an uncaught exception.
  notify(method, params = {}) { this.#trySend({ method, params }); }

  respond(id, result) { return this.#trySend({ id, result }); }
  respondError(id, code, message) { return this.#trySend({ id, error: { code, message } }); }

  #trySend(message) {
    try { this.#send(message); return true; } catch (error) {
      this.emit("stderr", `Dropped outbound App Server message (${error instanceof Error ? error.message : "send failed"})`);
      return false;
    }
  }

  #send(message) {
    if (!this.proc?.stdin.writable) throw new Error("Codex App Server is unavailable");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message;
    try { message = JSON.parse(trimmed); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `Codex App Server error (${message.error.code ?? "unknown"})`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) this.emit("request", message);
    else if (message.method) this.emit("notification", message);
  }

  #onExit(proc, error) {
    if (this.proc !== proc) return;
    this.ready = false;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }

  // Nulling `proc` first makes #onExit ignore the child's exit, so in-flight
  // requests used to sit unanswered until their own timeout (a 120s
  // thread/read held shutdown()'s allSettled that long). Reject them
  // here, through the same path the exit handler uses.
  async stop() {
    const proc = this.proc;
    if (!proc) { this.ready = false; return; }
    this.#onExit(proc, new Error("Codex App Server stopped"));
    try { proc.stdin.end(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
  }
}
