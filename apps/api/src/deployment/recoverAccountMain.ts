import { recoverAccount } from "./recoverAccount";

// Entry point of the recovery command (recoverAccount.ts). Paths are the container's.
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const userIndex = args.indexOf("--user");
const username = userIndex >= 0 ? args[userIndex + 1] : undefined;

if (flag("--help") || args.length === 0) {
  console.log([
    "Recover access to TracyHill RP (run inside the app container):",
    "  --user <name>         the account to work on",
    "  --reset-two-factor    remove its authenticator, recovery codes and trusted devices",
    "  --new-password        set a new random password, printed once, and sign it out everywhere",
    "  --two-factor-off      turn two-factor off for the whole server (then restart the app)",
  ].join("\n"));
  process.exit(args.length === 0 ? 1 : 0);
}

try {
  const result = await recoverAccount({
    dbFile: process.env.DB_FILE || "/app/data/v2/tracyhill-rp-v2.sqlite",
    username,
    resetTwoFactor: flag("--reset-two-factor"),
    newPassword: flag("--new-password"),
    twoFactorOff: flag("--two-factor-off"),
  });
  for (const line of result.lines) console.log(line);
} catch (err) {
  console.error(`[recover] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
