import { updateServerSettingsRequestSchema } from "@tracyhill-rp/contracts";
import { auditEvents, createDatabaseClient } from "@tracyhill-rp/db";

import { SettingsService, type SettingsEnvironment } from "../domain/settings/settingsService";
import { createId } from "../lib/ids";
import { validateEmail } from "../lib/password";
import type { EmailTransportConfig } from "../services/emailTransport";
import { sendTestEmail } from "../services/authEmail";

// Moves a deployment's email from the environment into Admin: Server settings. It stores the SendGrid settings the
// environment sets, through the same save
// as the admin page (the key encrypted), then proves them with a test email sent from the stored copy alone and records
// the result, so email stays working when the operator removes SENDGRID_API_KEY, EMAIL_FROM and EMAIL_FROM_NAME:
//
//   docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/adoptEnvEmailMain.ts --to <address>
//
// The environment keeps winning until the app is recreated without those variables. Nothing secret is printed.

const ACTOR = "env-email-adoption";

export type AdoptEmailOptions = {
  dbFile: string;
  to: string;
  // The app's raw values ("" when unset), as loadEnv reads them.
  environment: Pick<SettingsEnvironment, "sendgridApiKey" | "emailFrom" | "emailFromName">;
  send?: (transport: EmailTransportConfig, to: string) => Promise<void>;
};

export type AdoptEmailResult = { ok: boolean; lines: string[] };

function settingsEnvironment(email: AdoptEmailOptions["environment"]): SettingsEnvironment {
  return {
    ...email,
    exposeAuthCodes: false,
    trustProxy: "",
    allowedIps: "",
    defaultTimeZone: "UTC",
    providerKeys: {},
    codingPanels: () => ({ claudeCode: false, codex: false, kimi: false }),
  };
}

export async function adoptEnvironmentEmail(options: AdoptEmailOptions): Promise<AdoptEmailResult> {
  const to = options.to.trim().toLowerCase();
  if (validateEmail(to)) throw new Error("--to needs a valid email address to send the test to");
  const { db, sqlite } = createDatabaseClient(options.dbFile);
  try {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'server_settings'").get()) {
      throw new Error("This database has no server settings yet: start the updated app once, then run this again");
    }
    // What the app sends with today: the environment's values and their defaults.
    const current = new SettingsService(db, settingsEnvironment(options.environment));
    current.reload();
    const effective = current.emailTransport();
    if (!options.environment.sendgridApiKey || effective?.kind !== "sendgrid") {
      throw new Error("Nothing to adopt: SENDGRID_API_KEY is not set in this app's environment");
    }

    // The same service without the environment, as the app will run once the variables are gone.
    const settings = new SettingsService(db, settingsEnvironment({ sendgridApiKey: "", emailFrom: "", emailFromName: "" }));
    settings.reload();
    const patch = updateServerSettingsRequestSchema.parse({
      email: { provider: "sendgrid", sendgridApiKey: effective.apiKey, fromAddress: effective.fromAddress, fromName: effective.fromName },
    });
    const changed = settings.update(patch, ACTOR);
    const stored = settings.emailTransport();
    if (stored?.kind !== "sendgrid" || stored.apiKey !== effective.apiKey) {
      throw new Error("The stored key does not read back as the environment's; nothing was tested");
    }

    let error: string | null = null;
    try {
      await (options.send ?? sendTestEmail)(stored, to);
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    settings.recordEmailTest({ ok: error === null, to, error }, ACTOR);
    const now = new Date().toISOString();
    db.insert(auditEvents).values([
      { id: createId(), action: "settings.changed", actorUserId: null, actorRole: null, targetType: "server-settings", targetId: "server", metadataJson: JSON.stringify({ fields: changed, via: ACTOR }), createdAt: now },
      { id: createId(), action: "settings.email_tested", actorUserId: null, actorRole: null, targetType: "server-settings", targetId: "server", metadataJson: JSON.stringify({ ok: error === null, via: ACTOR }), createdAt: now },
    ]).run();

    const lines = [
      `Stored in Admin: Server settings: SendGrid, the key (encrypted), sender ${stored.fromName} <${stored.fromAddress}>.`,
    ];
    const ok = error === null && settings.emailWorking() && settings.emailSource() === "settings";
    if (ok) {
      lines.push(
        `Test email sent to ${to} from the stored settings alone; they count as working.`,
        "Next: remove SENDGRID_API_KEY, EMAIL_FROM and EMAIL_FROM_NAME from the server's .env and recreate the app",
        "(docker compose up -d). Until then the environment's values keep winning.",
      );
    } else {
      lines.push(
        error ? `The test email to ${to} failed: ${error}` : "The test was recorded but the settings do not count as working.",
        "Keep the .env lines until a test succeeds (Admin: Server settings → Send test email, once the .env lines are gone).",
      );
    }
    return { ok, lines };
  } finally {
    sqlite.close();
  }
}
