import crypto from "node:crypto";

import type { CurrentUser } from "@tracyhill-rp/contracts";

import { HttpError } from "../../lib/httpError";
import { createId } from "../../lib/ids";
import { hashPassword, validatePassword, validateUsername } from "../../lib/password";
import type { UserRepository } from "../users/userRepository";
import type { UserPreferencesRepository } from "../workspace/userPreferencesRepository";

// First-run setup. A fresh deployment has no accounts and no demo user. The
// server prints a one-time setup code in its log, and the person who enters it creates the first administrator, so
// whoever happens to reach a new instance first cannot claim it. The code exists only in this process's memory and in
// the log, changes on every restart, and stops working once any account exists.

// No 0/O, 1/I/L or U: the code is read off a terminal and typed by hand. Twelve characters carry about 59 bits.
const SETUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const SETUP_CODE_LENGTH = 12;

export function generateSetupCode(): string {
  let raw = "";
  for (let index = 0; index < SETUP_CODE_LENGTH; index += 1) raw += SETUP_CODE_ALPHABET[crypto.randomInt(SETUP_CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Upper case, without the dashes or spaces people type around it. */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sameCode(input: string, code: string) {
  const digest = (value: string) => crypto.createHash("sha256").update(normalizeSetupCode(value)).digest();
  return crypto.timingSafeEqual(digest(input), digest(code));
}

function printToLog(lines: string[]) {
  for (const line of lines) console.log(`[setup] ${line}`);
}

export class SetupService {
  private code: string | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly preferences: UserPreferencesRepository,
    private readonly print: (lines: string[]) => void = printToLog,
    // Writes the new server's settings (the setup browser's time zone, registration off, …).
    private readonly afterFirstAdmin: (details: { timeZone?: string }) => void = () => {},
  ) {}

  isSetupRequired() {
    return this.users.countUsers() === 0;
  }

  /** At boot: with no account yet, issue a code and print it. */
  announce() {
    if (this.isSetupRequired()) this.issueCode();
    else this.code = null;
  }

  /** Throws 409 once any account exists and 401 for a wrong code. */
  checkCode(input: string) {
    if (!this.isSetupRequired()) {
      this.code = null;
      throw new HttpError(409, "This server is already set up. Sign in instead.");
    }
    // No code yet: the accounts were removed while the server ran. Issue one now; whatever was typed cannot match it.
    const code = this.code ?? this.issueCode();
    if (!sameCode(input, code)) throw new HttpError(401, "That setup code is not right. Check the server log for the current one.");
  }

  async createFirstAdmin(input: { setupCode: string; username: string; password: string; timeZone?: string }): Promise<CurrentUser> {
    this.checkCode(input.setupCode);
    const username = input.username.trim();
    const usernameError = validateUsername(username);
    if (usernameError) throw new HttpError(400, usernameError);
    const passwordError = validatePassword(input.password);
    if (passwordError) throw new HttpError(400, passwordError);
    const passwordHash = await hashPassword(input.password);
    const now = new Date().toISOString();
    const id = createId();
    // The emptiness check and the insert share one transaction: of two forms sent at once, one wins.
    const created = this.users.createFirstUser({
      id,
      username,
      email: null,
      emailVerified: 0,
      agreedToTerms: 0,
      trustedDevices: "[]",
      role: "admin",
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    if (!created) {
      this.code = null;
      throw new HttpError(409, "This server is already set up. Sign in instead.");
    }
    this.preferences.ensureForUser(id, now);
    this.afterFirstAdmin({ timeZone: input.timeZone });
    this.code = null;
    this.print(["The administrator account was created. Setup is complete, and the setup code no longer works."]);
    return { id, username, role: "admin" };
  }

  private issueCode() {
    const code = generateSetupCode();
    this.code = code;
    this.print([
      "TracyHill RP has no accounts yet. Open it in a browser and enter this one-time setup code:",
      "",
      `    ${code}`,
      "",
      "The code works until the first account is created, and a new one is printed whenever the server restarts.",
    ]);
    return code;
  }
}
