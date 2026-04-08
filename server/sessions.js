import { Router } from "express";
import {
  requireAuth, loadSession, saveSession, deleteSessionFile,
  loadSessionsMeta, saveSessionsMeta, updateSessionMeta, removeSessionMeta, buildSessionMeta,
  loadUserMeta, saveUserMeta, isMigrated, migrateToPerSession,
  sessionsDir, safeSessionId, safeAlphanumId
} from "./shared.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const router = Router();

// ── Sessions metadata (sidebar) ──
router.get("/", requireAuth, (req, res) => {
  const userId = req.session.userId;
  // Auto-migrate on first access
  if (!isMigrated(userId)) {
    try { migrateToPerSession(userId); } catch (e) { console.error("Migration failed:", e.message); return res.status(500).json({ error: "Migration failed" }); }
  }
  res.json(loadSessionsMeta(userId));
});

// ── User preferences (meta) — must be before /:id to avoid conflict ──
router.get("/user/preferences", requireAuth, (req, res) => {
  res.json(loadUserMeta(req.session.userId));
});

router.put("/user/preferences", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const current = loadUserMeta(userId);
  if (req.body.activeId !== undefined) current.activeId = req.body.activeId;
  if (req.body.folders !== undefined) current.folders = req.body.folders;
  if (req.body.fontSize !== undefined) current.fontSize = req.body.fontSize;
  saveUserMeta(userId, current);
  res.json({ ok: true });
});

// ── Search across all sessions — must be before /:id to avoid conflict ──
router.get("/search/query", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);

  const meta = loadSessionsMeta(userId);
  const results = [];

  for (const [sid, entry] of Object.entries(meta)) {
    if (entry.deletedAt) continue; // skip deleted
    const session = loadSession(userId, sid);
    if (!session?.messages) continue;

    for (let i = 0; i < session.messages.length; i++) {
      const content = session.messages[i].content || "";
      const idx = content.toLowerCase().indexOf(q);
      if (idx !== -1) {
        // Extract snippet around match
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + q.length + 60);
        results.push({
          sessionId: sid,
          sessionName: entry.name,
          messageIndex: i,
          role: session.messages[i].role,
          snippet: (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : ""),
        });
        if (results.length >= 50) return res.json(results); // cap results
      }
    }
  }

  res.json(results);
});

// ── Empty recycle bin (bulk permanent delete) — must be before /:id ──
router.post("/bulk/empty-trash", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const meta = loadSessionsMeta(userId);
  let count = 0;
  for (const [sid, entry] of Object.entries(meta)) {
    if (entry.deletedAt) {
      deleteSessionFile(userId, sid);
      delete meta[sid];
      count++;
    }
  }
  saveSessionsMeta(userId, meta);
  res.json({ ok: true, deleted: count });
});

// ── Get full session (with messages) ──
router.get("/:id", requireAuth, (req, res) => {
  if (!safeSessionId(req.params.id) && !safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" });
  const session = loadSession(req.session.userId, req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// ── Create session ──
router.post("/", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const session = req.body;
  if (!session?.id || (!safeSessionId(session.id) && !safeAlphanumId(session.id))) return res.status(400).json({ error: "Invalid session" });

  saveSession(userId, session);
  updateSessionMeta(userId, session.id, buildSessionMeta(session));
  res.json({ ok: true, id: session.id });
});

// ── Update session metadata (rename, move folder, config changes) ──
router.put("/:id", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const existing = loadSession(userId, sessionId);
  if (!existing) return res.status(404).json({ error: "Session not found" });

  // Merge allowed fields (NOT messages — those go through /messages endpoints)
  const allowed = ["name", "selectedModel", "folderId", "campaignId", "sessionType", "deletedAt",
    "thinkingMode", "thinkingBudget", "effort", "cacheTTL", "autoScroll", "systemPrompt", "stateSeed"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) existing[key] = req.body[key];
  }

  saveSession(userId, existing);
  updateSessionMeta(userId, sessionId, buildSessionMeta(existing));
  res.json({ ok: true });
});

// ── Soft delete (recycle bin) ──
router.post("/:id/trash", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.deletedAt = Date.now();
  saveSession(userId, session);
  updateSessionMeta(userId, sessionId, { deletedAt: session.deletedAt });
  res.json({ ok: true });
});

// ── Restore from recycle bin ──
router.post("/:id/restore", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  delete session.deletedAt;
  saveSession(userId, session);
  updateSessionMeta(userId, sessionId, { deletedAt: null });
  res.json({ ok: true });
});

// ── Permanent delete ──
router.delete("/:id", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  deleteSessionFile(userId, sessionId);
  removeSessionMeta(userId, sessionId);
  res.json({ ok: true });
});

// ── Append message ──
router.post("/:id/messages", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Stale check: client sends expectedCount, server rejects if mismatch
  const expectedCount = req.body.expectedCount;
  if (expectedCount != null && session.messages.length !== expectedCount) {
    return res.status(409).json({ error: "stale", currentCount: session.messages.length });
  }

  const msg = req.body.message;
  if (!msg || !msg.role || !msg.content) return res.status(400).json({ error: "Invalid message" });

  session.messages.push(msg);

  // Auto-name on first user message
  if (session.messages.length === 1 && msg.role === "user") {
    session.name = msg.content.slice(0, 60) + (msg.content.length > 60 ? "\u2026" : "");
  }

  saveSession(userId, session);
  updateSessionMeta(userId, sessionId, {
    messageCount: session.messages.length,
    name: session.name,
    lastActivity: Date.now()
  });

  res.json({ ok: true, messageCount: session.messages.length, name: session.name });
});

// ── Edit message ──
router.put("/:id/messages/:index", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  const index = parseInt(req.params.index, 10);
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (index < 0 || index >= session.messages.length) return res.status(400).json({ error: "Invalid message index" });

  if (req.body.content !== undefined) session.messages[index].content = req.body.content;
  saveSession(userId, session);
  res.json({ ok: true });
});

// ── Delete message ──
router.delete("/:id/messages/:index", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  const index = parseInt(req.params.index, 10);
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (index < 0 || index >= session.messages.length) return res.status(400).json({ error: "Invalid message index" });

  session.messages.splice(index, 1);
  saveSession(userId, session);
  updateSessionMeta(userId, sessionId, { messageCount: session.messages.length });
  res.json({ ok: true, messageCount: session.messages.length });
});

// ── Truncate messages after index ──
router.post("/:id/messages/truncate", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const sessionId = req.params.id;
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return res.status(400).json({ error: "Invalid session id" });

  const session = loadSession(userId, sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const afterIndex = req.body.afterIndex;
  if (typeof afterIndex !== "number" || afterIndex < 0) return res.status(400).json({ error: "Invalid afterIndex" });

  session.messages = session.messages.slice(0, afterIndex + 1);
  saveSession(userId, session);
  updateSessionMeta(userId, sessionId, { messageCount: session.messages.length });
  res.json({ ok: true, messageCount: session.messages.length });
});

export default router;
