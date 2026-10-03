import crypto from "node:crypto";

import { eq } from "drizzle-orm";
import qrcode from "qrcode-generator";

import { userTwoFactor, type DatabaseClient } from "@tracyhill-rp/db";

import { decryptValue, encryptValue } from "../../lib/crypto";
import { HttpError } from "../../lib/httpError";
import { generateTotpSecret, groupKey, otpauthUri, verifyTotp } from "../../lib/totp";

// Authenticator-app two-factor. A pending secret becomes the active
// one only when a code from it is confirmed, so replacing a phone never leaves an account without a working factor.
// Recovery codes are shown once and stored hashed; each works once.

const ISSUER = "TracyHill RP";
// The first-run setup code's alphabet: no 0/O, 1/I/L or U, since recovery codes are typed by hand from paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const RECOVERY_CODE_COUNT = 10;

type RecoveryCode = { hash: string; usedAt: string | null };

export type TotpSetup = {
  // The key in groups of four, for typing into an app by hand.
  key: string;
  otpauthUri: string;
  // A QR code of the link, as an SVG data URL for an <img>.
  qrSvgDataUrl: string;
};

export type TwoFactorStatus = {
  enabled: boolean;
  recoveryCodesLeft: number;
};

/** XXXXX-XXXXX: ten characters, about 49 bits. */
export function generateRecoveryCode(): string {
  let raw = "";
  for (let index = 0; index < 10; index += 1) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** A recovery code as typed: case, spaces and dashes do not matter. */
export function looksLikeRecoveryCode(input: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(input.replace(/[\s-]/g, ""));
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");
}

export function qrSvgDataUrl(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export class TwoFactorService {
  constructor(
    private readonly db: DatabaseClient["db"],
    private readonly now: () => number = Date.now,
  ) {}

  private row(userId: string) {
    return this.db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).get();
  }

  isEnabled(userId: string): boolean {
    return Boolean(this.row(userId)?.totpEnabledAt);
  }

  status(userId: string): TwoFactorStatus {
    const row = this.row(userId);
    return {
      enabled: Boolean(row?.totpEnabledAt),
      recoveryCodesLeft: row?.totpEnabledAt ? this.recoveryCodes(row.recoveryCodesJson).filter((code) => !code.usedAt).length : 0,
    };
  }

  /** Starts, or restarts, setting up an authenticator. An active one keeps working until the new one is confirmed. */
  startSetup(userId: string, accountName: string): TotpSetup {
    const secret = generateTotpSecret();
    const now = new Date(this.now()).toISOString();
    this.db.insert(userTwoFactor)
      .values({ userId, pendingSecret: encryptValue(secret), pendingCreatedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: userTwoFactor.userId, set: { pendingSecret: encryptValue(secret), pendingCreatedAt: now, updatedAt: now } })
      .run();
    const uri = otpauthUri(ISSUER, accountName, secret);
    return { key: groupKey(secret), otpauthUri: uri, qrSvgDataUrl: qrSvgDataUrl(uri) };
  }

  /** Proves the pending secret with a current code, makes it the active one, and returns ten new recovery codes. */
  confirmSetup(userId: string, code: string): string[] {
    const row = this.row(userId);
    const pending = row?.pendingSecret ? this.read(row.pendingSecret) : "";
    if (!row || !pending) throw new HttpError(400, "Start setting up the authenticator again: no setup is waiting.");
    const step = verifyTotp(pending, code, this.now(), null);
    if (step === null) throw new HttpError(401, "That code is not right. Check the time on your phone, and use the newest code.");
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const now = new Date(this.now()).toISOString();
    this.db.update(userTwoFactor).set({
      totpSecret: encryptValue(pending),
      totpEnabledAt: now,
      totpLastStep: step,
      pendingSecret: null,
      pendingCreatedAt: null,
      recoveryCodesJson: JSON.stringify(codes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null }) satisfies RecoveryCode)),
      updatedAt: now,
    }).where(eq(userTwoFactor.userId, userId)).run();
    return codes;
  }

  /** A code from the active authenticator; each 30-second step works once. */
  verifyCode(userId: string, code: string): boolean {
    const row = this.row(userId);
    const secret = row?.totpEnabledAt && row.totpSecret ? this.read(row.totpSecret) : "";
    if (!row || !secret) return false;
    const step = verifyTotp(secret, code, this.now(), row.totpLastStep ?? null);
    if (step === null) return false;
    this.db.update(userTwoFactor).set({ totpLastStep: step, updatedAt: new Date(this.now()).toISOString() }).where(eq(userTwoFactor.userId, userId)).run();
    return true;
  }

  /** Spends one unused recovery code. */
  useRecoveryCode(userId: string, code: string): boolean {
    const row = this.row(userId);
    if (!row?.totpEnabledAt || !looksLikeRecoveryCode(code)) return false;
    const hash = hashRecoveryCode(code);
    const codes = this.recoveryCodes(row.recoveryCodesJson);
    const match = codes.find((entry) => !entry.usedAt && crypto.timingSafeEqual(Buffer.from(entry.hash, "hex"), Buffer.from(hash, "hex")));
    if (!match) return false;
    match.usedAt = new Date(this.now()).toISOString();
    this.db.update(userTwoFactor).set({ recoveryCodesJson: JSON.stringify(codes), updatedAt: match.usedAt }).where(eq(userTwoFactor.userId, userId)).run();
    return true;
  }

  /** Ten new recovery codes; the old ones stop working. */
  regenerateRecoveryCodes(userId: string): string[] {
    if (!this.isEnabled(userId)) throw new HttpError(400, "Set up the authenticator first.");
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    this.db.update(userTwoFactor).set({
      recoveryCodesJson: JSON.stringify(codes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null }) satisfies RecoveryCode)),
      updatedAt: new Date(this.now()).toISOString(),
    }).where(eq(userTwoFactor.userId, userId)).run();
    return codes;
  }

  /** Removes the authenticator, any setup in progress and the recovery codes. */
  remove(userId: string) {
    this.db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId)).run();
  }

  private recoveryCodes(json: string): RecoveryCode[] {
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? parsed.filter((entry): entry is RecoveryCode => Boolean(entry && typeof entry === "object" && typeof (entry as RecoveryCode).hash === "string")) : [];
    } catch {
      return [];
    }
  }

  private read(stored: string): string {
    try {
      return decryptValue(stored);
    } catch {
      // Unreadable after a session-secret change: the account sets the authenticator up again (an admin can reset it).
      return "";
    }
  }
}
