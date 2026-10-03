export function modeToSandbox(mode) {
  return mode === "yolo"
    ? { cli: "danger-full-access", policy: { type: "dangerFullAccess" } }
    : { cli: "read-only", policy: { type: "readOnly", networkAccess: false } };
}

export function sandboxToMode(sandbox) {
  const type = typeof sandbox === "string" ? sandbox : sandbox?.type;
  return type === "danger-full-access" || type === "dangerFullAccess" ? "yolo" : "read-only";
}

function toIso(seconds) {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

export function buildInputs(prompt, files = []) {
  const inputs = [];
  const text = String(prompt || "").trim();
  if (text) inputs.push({ type: "text", text, text_elements: [] });
  for (const file of files) {
    if (!file?.path) continue;
    if (file.kind === "image") inputs.push({ type: "localImage", path: file.path });
    else inputs.push({ type: "mention", name: file.name || file.path.split("/").at(-1) || "attachment", path: file.path });
  }
  if (!inputs.length) inputs.push({ type: "text", text: "See attached files.", text_elements: [] });
  return inputs;
}

export function threadToSummary(thread, metadata = {}, runtime = {}) {
  return {
    sessionId: thread.id,
    title: thread.name || metadata.title || undefined,
    preview: thread.preview || metadata.lastPrompt || undefined,
    workspaceId: metadata.workspaceId,
    workspaceName: metadata.workspaceName,
    cwd: thread.cwd || metadata.cwd,
    createdAt: toIso(thread.createdAt) || metadata.createdAt,
    updatedAt: toIso(thread.recencyAt ?? thread.updatedAt) || metadata.updatedAt,
    active: runtime.activeTurnId != null || thread.status?.type === "active",
    status: runtime.activeTurnId != null ? "running" : thread.status?.type || "idle",
    mode: metadata.mode || "read-only",
    model: metadata.model,
    effort: metadata.effort,
    serviceTier: metadata.serviceTier ?? null,
    pinned: Boolean(metadata.pinned),
    archived: Boolean(metadata.archived),
    forkedFromId: thread.forkedFromId ?? null,
    cliVersion: thread.cliVersion,
  };
}

export function exportThreadMarkdown(thread, descendants = []) {
  const lines = [`# ${thread.name || thread.preview || "Codex Session"}`, "", `- Session: \`${thread.id}\``, `- Working directory: \`${thread.cwd}\``, ""];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) lines.push(...itemToMarkdown(item));
  }
  if (descendants.length) {
    lines.push("## Subagents", "");
    for (const child of descendants) {
      lines.push(`### ${child.name || child.agentNickname || child.id}`, "");
      for (const turn of child.turns || []) for (const item of turn.items || []) lines.push(...itemToMarkdown(item));
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function itemToMarkdown(item) {
  if (item.type === "userMessage") {
    const text = (item.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return ["## You", "", text || "_[attachment]_", ""];
  }
  if (item.type === "agentMessage") return ["## Codex", "", item.text || "", "", ...questionsToMarkdown(item.questions)];
  if (item.type === "reasoning") return ["<details><summary>Reasoning</summary>", "", ...(item.summary?.length ? item.summary : item.content || []), "", "</details>", ""];
  if (item.type === "commandExecution") return [`### Command: \`${item.command}\``, "", "```text", item.aggregatedOutput || "", "```", ""];
  if (item.type === "fileChange") return ["### File changes", "", "```json", JSON.stringify(item.changes || [], null, 2), "```", ""];
  if (item.type === "mcpToolCall") return [`### MCP: ${item.server} · ${item.tool}`, "", "```json", JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2), "```", ""];
  if (item.type === "plan") return ["### Plan", "", item.text || "", ""];
  return [`### ${item.type}`, "", "```json", JSON.stringify(item, null, 2), "```", ""];
}

function questionsToMarkdown(questions) {
  if (!questions?.length) return [];
  const lines = ["### Questions", ""];
  for (const [index, question] of questions.entries()) {
    lines.push(`#### Question ${index + 1}`, "",
      ...markdownLiteral(question.title).split(/\r\n?|\n/).map((line) => `> ${line}`), "");
    if (question.options?.length) {
      lines.push(...question.options.map((option) => `- ${markdownLiteral(option).replace(/\r\n?|\n/g, "\n  ")}`), "");
    }
  }
  return lines;
}

// Native question titles/options are plain strings. Escape only those added
// fields; existing message and reasoning Markdown must retain its formatting.
function markdownLiteral(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
