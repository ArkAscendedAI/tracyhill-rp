import crypto from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS,
  emailProviderSchema,
  registrationModeSchema,
  smtpSecuritySchema,
  type EmailTestResult,
  type SecretSummary,
  type ServerSettings,
  type UpdateServerSettingsRequest,
} from "@tracyhill-rp/contracts";
import { auditEvents, serverSettings, users, type DatabaseClient } from "@tracyhill-rp/db";

import { decryptValue, encryptValue } from "../../lib/crypto";
import { HttpError } from "../../lib/httpError";
import { validateEmail } from "../../lib/password";
import type { EmailTransportConfig } from "../../services/emailTransport";
import { configureSessionExpiry, isValidTimeZone } from "../../services/sessionCookie";
import { SHARED_KEY_FIELDS } from "./sharedKeys";
import { recordSystemEvent } from "../system/systemEvents";

// The in-app server settings. One JSON value per section in
// `server_settings`; secrets inside it are encrypted with the provider-key cipher. A value an environment variable
// sets wins and is reported as locked. The API reads through this cache, and every write refreshes it, so a change
// applies without a restart.

const accountsSchema = z.object({
  registration: registrationModeSchema,
  termsRequired: z.boolean(),
  termsText: z.string(),
  privacyText: z.string(),
});
const twoFactorSchema = z.object({
  policy: z.enum(["off", "optional", "required"]),
  totp: z.boolean(),
  email: z.boolean(),
});
const sessionsSchema = z.object({
  signOutHour: z.number().int().min(0).max(23),
  timeZone: z.string(),
});
// Where new sessions start: only the keys the administrator set; the rest are the built-in
// defaults (packages/contracts/src/context.ts).
const sessionDefaultsSchema = z.object({
  worldStance: z.number().int().min(0).max(4).optional(),
  depictionTier: z.number().int().min(0).max(3).optional(),
});
const storedEmailSchema = z.object({
  provider: emailProviderSchema,
  fromAddress: z.string(),
  fromName: z.string(),
  // Encrypted; "" when none is stored.
  sendgridApiKey: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecurity: smtpSecuritySchema,
  smtpUsername: z.string(),
  smtpPassword: z.string(),
  lastTest: z.object({
    at: z.string(),
    ok: z.boolean(),
    to: z.string(),
    error: z.string().nullable(),
    // Which settings the test proved; any edit changes it, so the email is untested again.
    fingerprint: z.string(),
  }).nullable(),
});

export type AccountsSettings = z.infer<typeof accountsSchema>;
export type TwoFactorSettings = z.infer<typeof twoFactorSchema>;
export type SessionsSettings = z.infer<typeof sessionsSchema>;
export type SessionDefaults = z.infer<typeof sessionDefaultsSchema>;
type StoredEmail = z.infer<typeof storedEmailSchema>;

// Server-wide API keys by provider id, each encrypted.
const sharedKeysSchema = z.record(z.string(), z.string());

const SECTIONS = {
  sharedKeys: sharedKeysSchema,
  accounts: accountsSchema,
  twoFactor: twoFactorSchema,
  sessions: sessionsSchema,
  sessionDefaults: sessionDefaultsSchema,
  email: storedEmailSchema,
} as const;
type SectionKey = keyof typeof SECTIONS;

/** A new server's values (first-run setup writes them, with the setup browser's time zone). */
export const FRESH_ACCOUNTS: AccountsSettings = { registration: "off", termsRequired: true, termsText: "", privacyText: "" };
export const FRESH_TWO_FACTOR: TwoFactorSettings = { policy: "optional", totp: true, email: false };

/**
 * A server that had accounts before first-run setup existed keeps today's behavior: sign-up open while email works,
 * email codes at sign-in for verified addresses (TOTP becomes available to whoever wants it), and the original
 * 3 AM America/New_York sign-out.
 */
export const LEGACY_ACCOUNTS: AccountsSettings = { registration: "open", termsRequired: true, termsText: "", privacyText: "" };
export const LEGACY_TWO_FACTOR: TwoFactorSettings = { policy: "optional", totp: true, email: true };
export const LEGACY_SESSIONS: SessionsSettings = { signOutHour: 3, timeZone: "America/New_York" };
/** New sessions on a server that predates the 2026-10-02 defaults keep starting at the old, benign stance and tier. */
export const LEGACY_SESSION_DEFAULTS: SessionDefaults = { worldStance: 1, depictionTier: 0 };

const EMAIL_DEFAULT: StoredEmail = {
  provider: "none",
  fromAddress: "",
  fromName: "",
  sendgridApiKey: "",
  smtpHost: "",
  smtpPort: 587,
  smtpSecurity: "starttls",
  smtpUsername: "",
  smtpPassword: "",
  lastTest: null,
};

// What the environment-configured SendGrid sent from before these settings existed.
const ENV_FROM_ADDRESS_DEFAULT = "noreply@example.com";
const FROM_NAME_DEFAULT = "TracyHill RP";

export type SettingsEnvironment = {
  // Raw values: "" when the variable is unset.
  sendgridApiKey: string;
  emailFrom: string;
  emailFromName: string;
  exposeAuthCodes: boolean;
  trustProxy: string;
  allowedIps: string;
  // The zone a server falls back to when first-run setup did not report one.
  defaultTimeZone: string;
  // The provider keys the environment sets (ANTHROPIC_API_KEY …), by provider id: they win over shared keys.
  providerKeys: Record<string, string>;
  codingPanels: () => { claudeCode: boolean; codex: boolean; kimi: boolean };
};

const ENV_EMAIL_PROVIDER_FIELDS = ["email.provider", "email.sendgridApiKey", "email.smtpHost", "email.smtpPort", "email.smtpSecurity", "email.smtpUsername", "email.smtpPassword"];

export class SettingsService {
  private cache: { accounts: AccountsSettings | null; twoFactor: TwoFactorSettings | null; sessions: SessionsSettings | null; sessionDefaults: SessionDefaults | null; email: StoredEmail | null; sharedKeys: Record<string, string> | null } = {
    accounts: null, twoFactor: null, sessions: null, sessionDefaults: null, email: null, sharedKeys: null,
  };

  constructor(private readonly db: DatabaseClient["db"], private readonly environment: SettingsEnvironment) {}

  /** API boot: pins the first values on a server that has accounts, then loads everything. */
  initialize() {
    const hasUsers = (this.db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0) > 0;
    if (hasUsers) {
      const viaSetup = Boolean(this.db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.action, "setup.first_admin.created")).limit(1).get());
      this.insertIfMissing("accounts", viaSetup ? FRESH_ACCOUNTS : LEGACY_ACCOUNTS, "boot");
      this.insertIfMissing("twoFactor", viaSetup ? FRESH_TWO_FACTOR : LEGACY_TWO_FACTOR, "boot");
      this.insertIfMissing("sessions", viaSetup ? { signOutHour: 3, timeZone: this.environment.defaultTimeZone } : LEGACY_SESSIONS, "boot");
      if (!viaSetup) this.insertIfMissing("sessionDefaults", LEGACY_SESSION_DEFAULTS, "boot");
    }
    this.reload();
  }

  /** First-run setup: the new server's values, with the setup browser's zone when it is a real one. */
  writeFreshDefaults(timeZone: string | undefined) {
    const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : this.environment.defaultTimeZone;
    this.insertIfMissing("accounts", FRESH_ACCOUNTS, "setup");
    this.insertIfMissing("twoFactor", FRESH_TWO_FACTOR, "setup");
    this.insertIfMissing("sessions", { signOutHour: 3, timeZone: zone }, "setup");
    this.reload();
  }

  reload() {
    const rows = this.db.select().from(serverSettings).all();
    const next: SettingsService["cache"] = { accounts: null, twoFactor: null, sessions: null, sessionDefaults: null, email: null, sharedKeys: null };
    for (const row of rows) {
      if (!(row.key in SECTIONS)) continue;
      const key = row.key as SectionKey;
      let parsed: unknown;
      try {
        parsed = SECTIONS[key].parse(JSON.parse(row.value));
      } catch (err) {
        // A damaged value falls back to the defaults and says so, rather than taking the server down.
        recordSystemEvent({ userId: "__system__", source: "auth", severity: "error", message: `server setting "${key}" could not be read (${err instanceof Error ? err.message : String(err)}); its defaults apply until it is saved again` });
        continue;
      }
      (next as Record<SectionKey, unknown>)[key] = parsed;
    }
    this.cache = next;
    configureSessionExpiry(this.sessions());
  }

  accounts(): AccountsSettings {
    return this.cache.accounts ?? FRESH_ACCOUNTS;
  }

  twoFactor(): TwoFactorSettings {
    return this.cache.twoFactor ?? FRESH_TWO_FACTOR;
  }

  sessions(): SessionsSettings {
    return this.cache.sessions ?? { signOutHour: 3, timeZone: this.environment.defaultTimeZone };
  }

  /**
   * What a new session that inherits no campaign settings starts with: the server-wide stance and tier, or the built-in
   * ones. Always both, written into the session: its content level is then its own (a later change here or in the
   * built-in defaults leaves it alone), and a client that seeds its sheet from the session's own values, like the
   * Android app, never sends a stale fallback that the admin-only gate would refuse.
   */
  sessionDefaultOverrides(): Required<SessionDefaults> {
    const stored = this.cache.sessionDefaults ?? {};
    return {
      worldStance: stored.worldStance ?? CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.worldStance,
      depictionTier: stored.depictionTier ?? CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.depictionTier,
    };
  }

  /** The server-wide key for a provider (decrypted), or "": the environment's value is applied by withSharedKeys. */
  sharedKey(provider: string): string {
    return this.readSecret(this.cache.sharedKeys?.[provider] ?? "");
  }

  private storedEmail(): StoredEmail {
    return this.cache.email ?? EMAIL_DEFAULT;
  }

  /** Where the server's email comes from: the environment's SendGrid key wins. */
  emailSource(): "environment" | "settings" | "none" {
    if (this.environment.sendgridApiKey) return "environment";
    return this.storedEmail().provider === "none" ? "none" : "settings";
  }

  /** The transport the current settings describe, proven or not; null when something it needs is missing. */
  emailTransport(): EmailTransportConfig | null {
    const stored = this.storedEmail();
    const env = this.environment;
    const fromName = env.emailFromName || stored.fromName || FROM_NAME_DEFAULT;
    if (env.sendgridApiKey) {
      return { kind: "sendgrid", apiKey: env.sendgridApiKey, fromAddress: env.emailFrom || stored.fromAddress || ENV_FROM_ADDRESS_DEFAULT, fromName };
    }
    const fromAddress = env.emailFrom || stored.fromAddress;
    if (!fromAddress) return null;
    if (stored.provider === "sendgrid") {
      const apiKey = this.readSecret(stored.sendgridApiKey);
      return apiKey ? { kind: "sendgrid", apiKey, fromAddress, fromName } : null;
    }
    if (stored.provider === "smtp") {
      if (!stored.smtpHost) return null;
      return {
        kind: "smtp",
        host: stored.smtpHost,
        port: stored.smtpPort,
        security: stored.smtpSecurity,
        username: stored.smtpUsername,
        password: this.readSecret(stored.smtpPassword),
        fromAddress,
        fromName,
      };
    }
    return null;
  }

  /** Why the current settings cannot send, for the test button; null when they describe a complete transport. */
  emailTransportProblem(): string | null {
    if (this.emailTransport()) return null;
    const stored = this.storedEmail();
    if (stored.provider === "none") return "Choose SendGrid or SMTP first.";
    if (!(this.environment.emailFrom || stored.fromAddress)) return "Enter the sender address first.";
    if (stored.provider === "sendgrid") return "Enter the SendGrid API key first.";
    return "Enter the SMTP server first.";
  }

  /** Email works: configured in the environment, or a test succeeded with exactly the current settings. */
  emailWorking(): boolean {
    const source = this.emailSource();
    if (source === "environment") return true;
    if (source === "none" || !this.emailTransport()) return false;
    const test = this.storedEmail().lastTest;
    return Boolean(test?.ok && test.fingerprint === this.emailFingerprint());
  }

  /** Records the outcome of a test email against the current settings. */
  recordEmailTest(result: { ok: boolean; to: string; error: string | null }, actorUserId: string) {
    const stored = this.storedEmail();
    this.write("email", {
      ...stored,
      lastTest: { at: new Date().toISOString(), ok: result.ok, to: result.to, error: result.error, fingerprint: this.emailFingerprint() },
    }, actorUserId);
    this.reload();
  }

  /** The admin page's view: values, secret summaries, the email status, locked fields and the read-only environment. */
  view(): ServerSettings {
    const stored = this.storedEmail();
    const env = this.environment;
    const envSendgrid = Boolean(env.sendgridApiKey);
    const test = stored.lastTest;
    const lastTest: EmailTestResult | null = test ? { at: test.at, ok: test.ok, to: test.to, error: test.error } : null;
    return {
      accounts: { ...this.accounts() },
      email: {
        provider: envSendgrid ? "sendgrid" : stored.provider,
        fromAddress: env.emailFrom || stored.fromAddress || (envSendgrid ? ENV_FROM_ADDRESS_DEFAULT : ""),
        fromName: env.emailFromName || stored.fromName || (envSendgrid ? FROM_NAME_DEFAULT : ""),
        sendgridApiKey: envSendgrid ? summarize(env.sendgridApiKey) : this.summarizeStored(stored.sendgridApiKey),
        smtpHost: stored.smtpHost,
        smtpPort: stored.smtpPort,
        smtpSecurity: stored.smtpSecurity,
        smtpUsername: stored.smtpUsername,
        smtpPassword: this.summarizeStored(stored.smtpPassword),
        working: this.emailWorking(),
        source: this.emailSource(),
        lastTest,
      },
      sessions: { ...this.sessions() },
      twoFactor: { ...this.twoFactor() },
      sharedKeys: Object.fromEntries(Object.keys(SHARED_KEY_FIELDS).map((provider) => {
        const fromEnvironment = (env.providerKeys[provider] ?? "").trim();
        if (fromEnvironment) return [provider, { source: "environment" as const, ...summarize(fromEnvironment) }];
        const stored = this.sharedKey(provider);
        return [provider, stored ? { source: "settings" as const, ...summarize(stored) } : { source: "none" as const, configured: false, last4: null }];
      })),
      sessionDefaults: {
        worldStance: this.cache.sessionDefaults?.worldStance ?? CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.worldStance,
        depictionTier: this.cache.sessionDefaults?.depictionTier ?? CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.depictionTier,
        builtIn: { worldStance: CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.worldStance, depictionTier: CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.depictionTier },
      },
      locked: this.lockedFields(),
      environment: {
        trustProxy: env.trustProxy,
        allowedIps: env.allowedIps,
        codingPanels: env.codingPanels(),
      },
    };
  }

  /** Applies an admin's edit. Returns the dotted names of the fields that changed (never their values). */
  update(patch: UpdateServerSettingsRequest, actorUserId: string): string[] {
    const locked = new Set(this.lockedFields());
    const changed: string[] = [];
    const touch = (section: string, field: string) => {
      const name = `${section}.${field}`;
      if (locked.has(name)) throw new HttpError(400, `${name} is set in the server's configuration (.env); change it there`);
      changed.push(name);
    };

    if (patch.accounts) {
      const next = { ...this.accounts() };
      for (const [field, value] of Object.entries(patch.accounts) as Array<[keyof AccountsSettings, unknown]>) {
        if (value === undefined || next[field] === value) continue;
        touch("accounts", field);
        (next as Record<string, unknown>)[field] = value;
      }
      if (changed.some((name) => name.startsWith("accounts."))) this.write("accounts", accountsSchema.parse(next), actorUserId);
    }

    if (patch.email) {
      const next: StoredEmail = { ...this.storedEmail() };
      const e = patch.email;
      if (e.fromAddress !== undefined && e.fromAddress !== "" && validateEmail(e.fromAddress.toLowerCase())) {
        throw new HttpError(400, "The sender address is not a valid email address");
      }
      if (e.smtpHost !== undefined && e.smtpHost !== "" && !/^[A-Za-z0-9.-]+$/.test(e.smtpHost)) {
        throw new HttpError(400, "The SMTP server must be a host name or an address, without a scheme or a port");
      }
      const plain: Array<keyof StoredEmail & keyof typeof e> = ["provider", "fromAddress", "fromName", "smtpHost", "smtpPort", "smtpSecurity", "smtpUsername"];
      for (const field of plain) {
        const value = e[field];
        if (value === undefined || next[field] === value) continue;
        touch("email", field);
        (next as Record<string, unknown>)[field] = value;
      }
      for (const field of ["sendgridApiKey", "smtpPassword"] as const) {
        const value = e[field];
        if (value === undefined) continue;
        if (value === null && !next[field]) continue;
        touch("email", field);
        next[field] = value === null ? "" : encryptValue(value);
      }
      if (changed.some((name) => name.startsWith("email."))) this.write("email", storedEmailSchema.parse(next), actorUserId);
    }

    if (patch.sessions) {
      const next = { ...this.sessions() };
      if (patch.sessions.timeZone !== undefined && !isValidTimeZone(patch.sessions.timeZone)) {
        throw new HttpError(400, `"${patch.sessions.timeZone}" is not a time zone this server knows (use a name like Europe/Berlin)`);
      }
      for (const [field, value] of Object.entries(patch.sessions) as Array<[keyof SessionsSettings, unknown]>) {
        if (value === undefined || next[field] === value) continue;
        touch("sessions", field);
        (next as Record<string, unknown>)[field] = value;
      }
      if (changed.some((name) => name.startsWith("sessions."))) this.write("sessions", sessionsSchema.parse(next), actorUserId);
    }

    if (patch.twoFactor) {
      const next = { ...this.twoFactor(), ...Object.fromEntries(Object.entries(patch.twoFactor).filter(([, value]) => value !== undefined)) } as TwoFactorSettings;
      // Required sets up an authenticator for anyone who has no factor at their next sign-in, so it needs that method.
      if (next.policy === "required" && !next.totp) throw new HttpError(400, "Required needs the authenticator app method: it is how someone without a second factor sets one up at sign-in.");
      if (next.policy !== "off" && !next.totp && !next.email) throw new HttpError(400, "Choose at least one method, or set two-factor to Off.");
      for (const field of ["policy", "totp", "email"] as const) {
        if (next[field] !== this.twoFactor()[field]) touch("twoFactor", field);
      }
      if (changed.some((name) => name.startsWith("twoFactor."))) this.write("twoFactor", twoFactorSchema.parse(next), actorUserId);
    }

    if (patch.sharedKeys) {
      const next: Record<string, string> = { ...(this.cache.sharedKeys ?? {}) };
      for (const [provider, value] of Object.entries(patch.sharedKeys)) {
        if (value === undefined || !(provider in SHARED_KEY_FIELDS)) continue;
        if (value === null && !next[provider]) continue;
        touch("sharedKeys", provider);
        if (value === null) delete next[provider];
        else next[provider] = encryptValue(value);
      }
      if (changed.some((name) => name.startsWith("sharedKeys."))) this.write("sharedKeys", sharedKeysSchema.parse(next), actorUserId);
    }

    if (patch.sessionDefaults) {
      const next: SessionDefaults = { ...(this.cache.sessionDefaults ?? {}) };
      for (const [field, value] of Object.entries(patch.sessionDefaults) as Array<[keyof SessionDefaults, number | null | undefined]>) {
        if (value === undefined) continue;
        if (value === null) {
          if (next[field] === undefined) continue;
          delete next[field];
        } else {
          if (next[field] === value) continue;
          next[field] = value;
        }
        touch("sessionDefaults", field);
      }
      if (changed.some((name) => name.startsWith("sessionDefaults."))) this.write("sessionDefaults", sessionDefaultsSchema.parse(next), actorUserId);
    }

    this.reload();
    return changed;
  }

  private lockedFields(): string[] {
    const env = this.environment;
    const locked: string[] = [];
    if (env.sendgridApiKey) locked.push(...ENV_EMAIL_PROVIDER_FIELDS);
    if (env.emailFrom) locked.push("email.fromAddress");
    if (env.emailFromName) locked.push("email.fromName");
    for (const provider of Object.keys(SHARED_KEY_FIELDS)) {
      if ((env.providerKeys[provider] ?? "").trim()) locked.push(`sharedKeys.${provider}`);
    }
    return locked;
  }

  // The stored ciphertexts change only when a secret is replaced, so hashing them (never a plaintext) is enough to tell
  // a proven configuration from an edited one.
  private emailFingerprint(): string {
    const stored = this.storedEmail();
    const env = this.environment;
    const material = JSON.stringify({
      provider: stored.provider,
      fromAddress: env.emailFrom || stored.fromAddress,
      fromName: env.emailFromName || stored.fromName,
      sendgridApiKey: stored.sendgridApiKey,
      smtpHost: stored.smtpHost,
      smtpPort: stored.smtpPort,
      smtpSecurity: stored.smtpSecurity,
      smtpUsername: stored.smtpUsername,
      smtpPassword: stored.smtpPassword,
    });
    return crypto.createHash("sha256").update(material).digest("hex");
  }

  private readSecret(stored: string): string {
    if (!stored) return "";
    try {
      return decryptValue(stored);
    } catch {
      // Unreadable after a session-secret change: treated as missing, and the page asks for it again.
      return "";
    }
  }

  private summarizeStored(stored: string): SecretSummary {
    const plain = this.readSecret(stored);
    return plain ? summarize(plain) : { configured: false, last4: null };
  }

  private insertIfMissing(key: SectionKey, value: unknown, updatedBy: string) {
    this.db.insert(serverSettings)
      .values({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString(), updatedBy })
      .onConflictDoNothing()
      .run();
  }

  private write(key: SectionKey, value: unknown, updatedBy: string) {
    const now = new Date().toISOString();
    this.db.insert(serverSettings)
      .values({ key, value: JSON.stringify(value), updatedAt: now, updatedBy })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: JSON.stringify(value), updatedAt: now, updatedBy } })
      .run();
  }
}

function summarize(secret: string): SecretSummary {
  return { configured: true, last4: secret.length > 8 ? secret.slice(-4) : null };
}
