import { loadEnv } from "../config/env";
import { initEncryptionKey } from "../lib/crypto";
import { adoptEnvironmentEmail } from "./adoptEnvEmail";

// Entry point of the email adoption command (adoptEnvEmail.ts). It reads the app's own configuration, so the key is
// encrypted with the same secret the app uses.
const args = process.argv.slice(2);
const toIndex = args.indexOf("--to");
const to = toIndex >= 0 ? args[toIndex + 1] : undefined;

if (args.includes("--help") || !to) {
  console.log([
    "Move the .env email settings into Admin: Server settings (run inside the app container):",
    "  --to <address>   where the test email goes; the settings count as working only if it is sent",
  ].join("\n"));
  process.exit(args.includes("--help") ? 0 : 1);
}

try {
  const env = loadEnv();
  initEncryptionKey(env.sessionSecret);
  const result = await adoptEnvironmentEmail({
    dbFile: env.dbFile,
    to,
    environment: { sendgridApiKey: env.sendgridApiKey, emailFrom: env.emailFrom, emailFromName: env.emailFromName },
  });
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 2);
} catch (err) {
  console.error(`[adopt-email] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
