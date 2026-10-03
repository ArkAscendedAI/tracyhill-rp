import { PANEL_MANIFEST, LEGACY_MANIFEST } from "./config.js";
import { fileExists, readJson, writeJsonAtomic } from "./jsonStore.js";

const EMPTY = { version: 2, sessions: {} };

export class PanelManifest {
  constructor(path = PANEL_MANIFEST, legacyPath = LEGACY_MANIFEST) {
    this.path = path;
    this.legacyPath = legacyPath;
    if (!fileExists(this.path)) writeJsonAtomic(this.path, EMPTY);
  }

  read() {
    const value = readJson(this.path, EMPTY);
    return value?.version === 2 && value.sessions && typeof value.sessions === "object" ? value : structuredClone(EMPTY);
  }

  list() { return Object.values(this.read().sessions); }
  get(sessionId) { return this.read().sessions[sessionId] ?? null; }
  has(sessionId) { return Boolean(this.get(sessionId)); }

  upsert(sessionId, patch) {
    const data = this.read();
    const now = new Date().toISOString();
    const current = data.sessions[sessionId] ?? { sessionId, createdAt: now, source: "app-server" };
    data.sessions[sessionId] = { ...current, ...patch, sessionId, updatedAt: patch.updatedAt ?? now };
    writeJsonAtomic(this.path, data);
    return data.sessions[sessionId];
  }

  remove(sessionId) {
    const data = this.read();
    delete data.sessions[sessionId];
    writeJsonAtomic(this.path, data);
  }

  legacyCount() {
    const legacy = readJson(this.legacyPath, {});
    return legacy && typeof legacy === "object" ? Object.keys(legacy).length : 0;
  }
}
