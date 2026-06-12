import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:";

let derivedKey: Buffer | null = null;

/**
 * Derive a 256-bit encryption key from the session secret via HKDF.
 * Called once at startup.
 */
export function initEncryptionKey(sessionSecret: string) {
  derivedKey = Buffer.from(crypto.hkdfSync("sha256", sessionSecret, "tracyhill-rp-provider-keys", "aes-256-gcm-key", 32));
}

function getKey(): Buffer {
  if (!derivedKey) throw new Error("Encryption key not initialized — call initEncryptionKey() at startup");
  return derivedKey;
}

/**
 * Encrypt a plaintext string. Returns a prefixed string: "enc:<iv>:<tag>:<ciphertext>" (all hex).
 * Returns empty string for empty/whitespace-only input.
 */
export function encryptValue(plaintext: string): string {
  if (!plaintext.trim()) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a value produced by encryptValue().
 * If the value doesn't start with "enc:", it's treated as legacy plaintext and returned as-is
 * (enables transparent migration of existing unencrypted keys).
 */
export function decryptValue(stored: string): string {
  if (!stored.trim()) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext — transparent migration
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted value");
  const [ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex!, "hex");
  const tag = Buffer.from(tagHex!, "hex");
  const ciphertext = Buffer.from(ciphertextHex!, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Check if a stored value is already encrypted.
 */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
