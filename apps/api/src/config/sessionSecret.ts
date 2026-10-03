import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The deployment's own session secret when SESSION_SECRET is not set (generated
// automatically, random per deployment, so no two installs share a secret nobody changed). It lives beside the
// database, so a backup of the data directory carries it: without it, a restored database cannot decrypt the
// stored provider keys. Docker deployments get it from the init service (deployment/init.ts) before any app
// process starts; a bare-node API generates it itself (config/env.ts). Every other reader only reads.

export const SESSION_SECRET_RELATIVE_PATH = "data/v2/session.secret";
export const MIN_SESSION_SECRET_LENGTH = 32;

export function sessionSecretPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, SESSION_SECRET_RELATIVE_PATH);
}

/** The stored secret, or null when the file is missing or too short to be one this code wrote. */
export function readStoredSessionSecret(file: string = sessionSecretPath()): string | null {
  try {
    const value = fs.readFileSync(file, "utf-8").trim();
    return value.length >= MIN_SESSION_SECRET_LENGTH ? value : null;
  } catch {
    return null;
  }
}

/** 48 bytes from the system CSPRNG, as 96 hex characters. */
export function generateSessionSecret(): string {
  return crypto.randomBytes(48).toString("hex");
}

/** A bare-node API's secret: the stored one, or a new one written once (0600, never over an existing file). A file
 *  that exists but holds no usable secret stops the API, as it stops the init service: a damaged secret is the
 *  operator's to look at, and replacing it would make every stored key unreadable. */
export function loadOrCreateSessionSecret(file: string = sessionSecretPath()): string {
  const existing = readStoredSessionSecret(file);
  if (existing) return existing;
  if (fs.existsSync(file)) {
    throw new Error(`${file} exists but holds no usable secret (under ${MIN_SESSION_SECRET_LENGTH} characters); fix or remove it, or set SESSION_SECRET`);
  }
  const generated = generateSessionSecret();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600, flag: "wx" });
  return generated;
}
