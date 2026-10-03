import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return structuredClone(fallback); }
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export function fileExists(path) { return existsSync(path); }
