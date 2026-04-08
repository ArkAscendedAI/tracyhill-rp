import { createServer } from "https";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AGENT_PORT || "7701", 10);
const SECRET = process.env.AGENT_SECRET || "";
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "127.0.0.1,::1,::ffff:127.0.0.1").split(",").map(s => s.trim()).filter(Boolean);
const DATA_DIR = join(__dirname, "data");
const MANIFEST = join(DATA_DIR, "sessions.json");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const OUTPUTS_DIR = join(DATA_DIR, "outputs");
const UPLOAD_DIR = "/tmp/codex-uploads";
const WORKSPACES = parseWorkspaces(process.env.WORKSPACES_JSON);
const tlsOpts = {
  key: readFileSync(join(__dirname, "certs", "agent-key.pem")),
  cert: readFileSync(join(__dirname, "certs", "agent-cert.pem")),
};

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
if (!existsSync(OUTPUTS_DIR)) mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const activeRuns = new Map(); // sessionId -> { proc, cleanupFiles: [] }

function parseWorkspaces(raw) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  // Default workspace — override with WORKSPACES_JSON env var
  const home = process.env.HOME || "/home/user";
  return {
    default: { id: "default", name: "Home", cwd: home },
  };
}

function safeId(id) { return typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id); }

function loadManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return {}; }
}

function saveManifest(data) {
  const tmp = MANIFEST + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, MANIFEST);
}

function updateManifest(sessionId, patch) {
  const manifest = loadManifest();
  manifest[sessionId] = { ...(manifest[sessionId] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveManifest(manifest);
  return manifest[sessionId];
}

function deleteManifestSession(sessionId) {
  const manifest = loadManifest();
  delete manifest[sessionId];
  saveManifest(manifest);
}

function sessionPath(sessionId) { return join(SESSIONS_DIR, `${sessionId}.json`); }

function loadTranscript(sessionId) {
  try { return JSON.parse(readFileSync(sessionPath(sessionId), "utf8")); } catch { return []; }
}

function saveTranscript(sessionId, items) {
  const tmp = sessionPath(sessionId) + ".tmp";
  writeFileSync(tmp, JSON.stringify(items, null, 2), "utf8");
  renameSync(tmp, sessionPath(sessionId));
}

function appendTranscript(sessionId, item) {
  const items = loadTranscript(sessionId);
  items.push(item);
  saveTranscript(sessionId, items);
}

function upsertTranscript(sessionId, itemId, patch, create) {
  const items = loadTranscript(sessionId);
  const idx = items.findIndex(i => i.id === itemId);
  if (idx >= 0) items[idx] = { ...items[idx], ...patch };
  else if (create) items.push({ id: itemId, ...create, ...patch });
  saveTranscript(sessionId, items);
}

function outputDir(sessionId) {
  const dir = join(OUTPUTS_DIR, sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function storeCommandOutput(sessionId, itemId, text) {
  const fp = join(outputDir(sessionId), `${itemId}.log`);
  writeFileSync(fp, text, "utf8");
  return fp;
}

function outputPreview(text, limit = 1200) {
  const normalized = text || "";
  if (!normalized) return { text: "", truncated: false };
  if (normalized.length <= limit) return { text: normalized, truncated: false };
  const head = normalized.slice(0, Math.floor(limit / 2));
  const tail = normalized.slice(-Math.floor(limit / 2));
  return { text: `${head}\n\n...[output truncated]...\n\n${tail}`, truncated: true };
}

function workspaceById(id) {
  return id && WORKSPACES[id] ? WORKSPACES[id] : null;
}

function checkAuth(req, res) {
  const ip = (req.socket.remoteAddress || "").replace("::ffff:", "");
  if (!ALLOWED_IPS.includes(ip) && !ALLOWED_IPS.includes(req.socket.remoteAddress || "")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return false;
  }
  const auth = req.headers.authorization;
  if (!SECRET || auth !== `Bearer ${SECRET}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve({}); }
    });
  });
}

function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function cleanUploads() {
  try {
    const now = Date.now();
    for (const f of readdirSync(UPLOAD_DIR)) {
      const fp = join(UPLOAD_DIR, f);
      try { if (now - statSync(fp).mtimeMs > 3600000) unlinkSync(fp); } catch {}
    }
  } catch {}
}

setInterval(cleanUploads, 600000);

async function handleUpload(req, res) {
  const body = await readBody(req);
  const { name, data } = body;
  if (!name || !data) return sendJson(res, 400, { error: "name and data required" });
  const safeName = `${Date.now()}-${String(name).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const filePath = join(UPLOAD_DIR, safeName);
  writeFileSync(filePath, Buffer.from(data, "base64"));
  sendJson(res, 200, { path: filePath, name: safeName });
}

function cleanupFiles(files) {
  for (const fp of files) {
    try { if (fp.startsWith(UPLOAD_DIR)) unlinkSync(fp); } catch {}
  }
}

function buildPrompt(prompt, files) {
  const notePaths = (files || []).filter(f => f?.path && f.kind !== "image").map(f => `- ${f.path}`);
  if (!notePaths.length) return prompt;
  return `${prompt}\n\nAttached files available on disk:\n${notePaths.join("\n")}\n\nRead them directly from those paths before acting.`;
}

function codexArgs({ prompt, sessionId, cwd, imagePaths }) {
  const images = (imagePaths || []).flatMap(fp => ["-i", fp]);
  if (sessionId) return ["exec", "resume", "--json", "--skip-git-repo-check", ...images, sessionId, prompt];
  return ["exec", "--json", "--skip-git-repo-check", "--cd", cwd, ...images, prompt];
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const files = Array.isArray(body.files) ? body.files.filter(f => f?.path) : [];
  const prompt = String(body.prompt || "").trim() || (files.length ? "See attached files." : "");
  if (!prompt) return sendJson(res, 400, { error: "prompt required" });
  const requestedId = body.sessionId ? String(body.sessionId) : null;
  const existing = requestedId ? loadManifest()[requestedId] : null;
  const workspace = requestedId ? workspaceById(existing?.workspaceId) : workspaceById(body.workspaceId);
  if (!workspace) return sendJson(res, 400, { error: "Invalid workspace" });
  if (requestedId && activeRuns.has(requestedId)) return sendJson(res, 409, { error: "Session already running" });

  const fullPrompt = buildPrompt(prompt, files);
  const imagePaths = files.filter(f => f.kind === "image" && typeof f.path === "string").map(f => f.path);
  const cleanupList = files.map(f => f.path).filter(Boolean);
  const args = codexArgs({ prompt: fullPrompt, sessionId: requestedId, cwd: workspace.cwd, imagePaths });
  const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  const localErr = [];
  let browserGone = false;
  let sessionId = requestedId;
  let finished = false;
  let stdoutBuf = "";

  const markDone = (patch = {}) => {
    if (!sessionId) return;
    updateManifest(sessionId, { running: false, ...patch });
    activeRuns.delete(sessionId);
  };

  const emit = (event, data) => { if (!browserGone) try { sseWrite(res, event, data); } catch {} };

  req.on("close", () => { browserGone = true; });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no" });

  if (requestedId) {
    appendTranscript(requestedId, { id: `user-${Date.now()}`, type: "user", content: prompt, files: files.map(({ name, path, kind, size }) => ({ name, path, kind, size })), createdAt: new Date().toISOString() });
    updateManifest(requestedId, { lastPrompt: prompt.slice(0, 200), running: true });
  }

  child.stdout.on("data", chunk => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }

      if (evt.type === "thread.started" && evt.thread_id) {
        sessionId = evt.thread_id;
        const isNew = !requestedId;
        updateManifest(sessionId, {
          sessionId,
          title: prompt.slice(0, 80) || "Untitled",
          preview: prompt.slice(0, 120) || "Untitled",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          cwd: workspace.cwd,
          createdAt: loadManifest()[sessionId]?.createdAt || new Date().toISOString(),
          running: true,
          lastPrompt: prompt.slice(0, 200),
        });
        if (isNew) appendTranscript(sessionId, { id: `user-${Date.now()}`, type: "user", content: prompt, files: files.map(({ name, path, kind, size }) => ({ name, path, kind, size })), createdAt: new Date().toISOString() });
        activeRuns.set(sessionId, { proc: child, cleanupList });
        emit("system", { sessionId, cwd: workspace.cwd, workspaceId: workspace.id, workspaceName: workspace.name, resumed: !!requestedId });
        continue;
      }

      if (!sessionId) continue;

      if (evt.type === "item.started" && evt.item?.type === "command_execution") {
        upsertTranscript(sessionId, evt.item.id, {
          type: "command",
          command: evt.item.command,
          cwd: workspace.cwd,
          status: "running",
          exitCode: null,
          outputPreview: "",
          outputBytes: 0,
          outputPath: null,
          startedAt: new Date().toISOString(),
        }, {
          type: "command",
          command: evt.item.command,
          cwd: workspace.cwd,
          status: "running",
          exitCode: null,
          outputPreview: "",
          outputBytes: 0,
          outputPath: null,
          startedAt: new Date().toISOString(),
        });
        emit("command_start", { id: evt.item.id, command: evt.item.command, cwd: workspace.cwd });
        continue;
      }

      if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
        const content = evt.item.text || "";
        appendTranscript(sessionId, { id: evt.item.id, type: "text", content, createdAt: new Date().toISOString() });
        emit("text", { id: evt.item.id, content });
        continue;
      }

      if (evt.type === "item.completed" && evt.item?.type === "command_execution") {
        const output = evt.item.aggregated_output || "";
        const preview = outputPreview(output);
        const outputPath = output ? storeCommandOutput(sessionId, evt.item.id, output) : null;
        upsertTranscript(sessionId, evt.item.id, {
          type: "command",
          command: evt.item.command,
          cwd: workspace.cwd,
          status: evt.item.status || "completed",
          exitCode: evt.item.exit_code,
          outputPreview: preview.text,
          outputTruncated: preview.truncated,
          outputBytes: Buffer.byteLength(output, "utf8"),
          hasFullOutput: !!outputPath,
          outputPath,
          completedAt: new Date().toISOString(),
        }, {
          type: "command",
          command: evt.item.command,
          cwd: workspace.cwd,
          status: evt.item.status || "completed",
          exitCode: evt.item.exit_code,
          outputPreview: preview.text,
          outputTruncated: preview.truncated,
          outputBytes: Buffer.byteLength(output, "utf8"),
          hasFullOutput: !!outputPath,
          outputPath,
          completedAt: new Date().toISOString(),
        });
        emit("command_end", {
          id: evt.item.id,
          command: evt.item.command,
          status: evt.item.status || "completed",
          exitCode: evt.item.exit_code,
          outputPreview: preview.text,
          outputTruncated: preview.truncated,
          outputBytes: Buffer.byteLength(output, "utf8"),
          hasFullOutput: !!outputPath,
        });
        continue;
      }

      if (evt.type === "turn.completed") {
        finished = true;
        appendTranscript(sessionId, { id: `result-${Date.now()}`, type: "result", sessionId, usage: evt.usage || null, createdAt: new Date().toISOString() });
        markDone();
        emit("result", { sessionId, usage: evt.usage || null });
        if (!browserGone) try { res.end(); } catch {}
        cleanupFiles(cleanupList);
        continue;
      }

      if ((evt.type === "turn.failed" || evt.type === "error") && !finished) {
        finished = true;
        const message = evt.error?.message || evt.message || "Codex turn failed";
        appendTranscript(sessionId, { id: `error-${Date.now()}`, type: "error", content: message, createdAt: new Date().toISOString() });
        markDone({ lastError: message });
        emit("error", { sessionId, message });
        if (!browserGone) try { res.end(); } catch {}
        cleanupFiles(cleanupList);
      }
    }
  });

  child.stderr.on("data", chunk => {
    const text = chunk.toString("utf8");
    if (text.trim()) localErr.push(text.trim());
  });

  child.on("close", code => {
    if (!finished) {
      const message = localErr.join("\n") || `Codex exited with code ${code}`;
      if (sessionId) {
        appendTranscript(sessionId, { id: `error-${Date.now()}`, type: "error", content: message, createdAt: new Date().toISOString() });
        markDone({ lastError: message });
        emit("error", { sessionId, message });
      } else emit("error", { message });
    }
    cleanupFiles(cleanupList);
    if (!browserGone) try { res.end(); } catch {}
  });
}

function handleList(req, res) {
  const sessions = Object.values(loadManifest()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  sendJson(res, 200, sessions);
}

function handleMessages(req, res, sessionId) {
  if (!safeId(sessionId)) return sendJson(res, 400, { error: "Invalid session id" });
  sendJson(res, 200, loadTranscript(sessionId));
}

function handleOutput(req, res, sessionId, itemId) {
  if (!safeId(sessionId) || !safeId(itemId)) return sendJson(res, 400, { error: "Invalid id" });
  const items = loadTranscript(sessionId);
  const item = items.find(i => i.id === itemId && i.type === "command");
  if (!item) return sendJson(res, 404, { error: "Output not found" });
  let output = item.outputPreview || "";
  if (item.outputPath && existsSync(item.outputPath)) output = readFileSync(item.outputPath, "utf8");
  sendJson(res, 200, { output });
}

function handleInterrupt(req, res, sessionId) {
  if (!safeId(sessionId)) return sendJson(res, 400, { error: "Invalid session id" });
  const run = activeRuns.get(sessionId);
  if (!run?.proc) return sendJson(res, 404, { error: "Session is not running" });
  try { run.proc.kill("SIGINT"); } catch {}
  setTimeout(() => { try { run.proc.kill("SIGKILL"); } catch {} }, 5000);
  sendJson(res, 200, { ok: true });
}

function handleDelete(req, res, sessionId) {
  if (!safeId(sessionId)) return sendJson(res, 400, { error: "Invalid session id" });
  const run = activeRuns.get(sessionId);
  if (run?.proc) {
    try { run.proc.kill("SIGKILL"); } catch {}
    activeRuns.delete(sessionId);
  }
  try { rmSync(sessionPath(sessionId), { force: true }); } catch {}
  try { rmSync(join(OUTPUTS_DIR, sessionId), { recursive: true, force: true }); } catch {}
  deleteManifestSession(sessionId);
  sendJson(res, 200, { ok: true });
}

function handleStatus(req, res) {
  const workspaces = Object.values(WORKSPACES).map(w => ({ id: w.id, name: w.name, cwd: w.cwd }));
  sendJson(res, 200, { ok: true, workspaces });
}

const server = createServer(tlsOpts, async (req, res) => {
  if (!checkAuth(req, res)) return;
  const url = new URL(req.url, `https://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "GET" && path === "/status") return handleStatus(req, res);
  if (req.method === "POST" && path === "/upload") return handleUpload(req, res);
  if (req.method === "POST" && path === "/sessions") return handlePost(req, res);
  if (req.method === "GET" && path === "/sessions") return handleList(req, res);
  if (req.method === "GET" && path.match(/^\/sessions\/[^/]+\/messages$/)) return handleMessages(req, res, path.split("/")[2]);
  if (req.method === "GET" && path.match(/^\/sessions\/[^/]+\/output\/[^/]+$/)) {
    const parts = path.split("/");
    return handleOutput(req, res, parts[2], parts[4]);
  }
  if (req.method === "POST" && path.match(/^\/sessions\/[^/]+\/interrupt$/)) return handleInterrupt(req, res, path.split("/")[2]);
  if (req.method === "DELETE" && path.startsWith("/sessions/")) return handleDelete(req, res, path.slice("/sessions/".length));
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Codex Agent Service listening on https://0.0.0.0:${PORT}`);
  console.log(`Allowed IPs: ${ALLOWED_IPS.join(", ")}`);
});
