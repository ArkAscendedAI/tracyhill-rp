import fs from "node:fs";
import path from "node:path";

import { deriveRunnerSecret } from "@tracyhill-rp/provider-runtime";

import { generateSessionSecret, MIN_SESSION_SECRET_LENGTH } from "../config/sessionSecret";

// One-shot preparation run as root by the `tracyhill-rp-init` Compose service before the API, the worker and the
// runner start, so Docker deploys out of the box with a random secret per deployment.
//
// 1. Docker creates a missing bind-mount source (`./data` on a fresh clone) owned by root, and the app runs as
//    UID 1001, so on Linux it could not write its own data directory. A root-owned data directory is handed to
//    the app user; a directory with any other owner is left exactly as it is.
// 2. With SESSION_SECRET unset, the deployment gets its own random secret on first boot, stored beside the
//    database (`v2/session.secret`, mode 0600) so a backup of the data directory carries it. An operator's value
//    always wins, and an existing stored secret is never replaced: rotating it signs every user out and makes
//    every stored provider key unreadable.
// 3. The subscription runner gets the secret derived from the session secret (the API and the worker derive the
//    same one) through a small shared volume, so the runner never holds the session secret itself. An operator's
//    RUNNER_SECRET wins and no file is written.

export const APP_UID = 1001;
export const APP_GID = 1001;

export type InitOptions = {
  dataDir: string;
  runnerSecretFile: string;
  env: Record<string, string | undefined>;
  chown?: (target: string, uid: number, gid: number) => void;
  log?: (message: string) => void;
};

export type InitResult = {
  dataDirHandedOver: boolean;
  sessionSecret: "operator" | "existing" | "generated";
  runnerSecret: "operator" | "written";
};

export function initDeployment(options: InitOptions): InitResult {
  const chown = options.chown ?? ((target, uid, gid) => fs.chownSync(target, uid, gid));
  const log = options.log ?? ((message) => console.log(`[init] ${message}`));
  const { dataDir, runnerSecretFile, env } = options;

  let dataDirHandedOver = false;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    chown(dataDir, APP_UID, APP_GID);
    dataDirHandedOver = true;
  } else if (fs.statSync(dataDir).uid === 0) {
    chown(dataDir, APP_UID, APP_GID);
    dataDirHandedOver = true;
  }
  log(dataDirHandedOver ? `data directory handed to the app user (UID ${APP_UID})` : "data directory already owned by a non-root user; left as it is");
  const v2Dir = path.join(dataDir, "v2");
  if (!fs.existsSync(v2Dir)) {
    fs.mkdirSync(v2Dir);
    chown(v2Dir, APP_UID, APP_GID);
  }

  let secret: string;
  let sessionSecret: InitResult["sessionSecret"];
  const operator = (env.SESSION_SECRET ?? "").trim();
  if (operator) {
    secret = operator;
    sessionSecret = "operator";
    log("session secret: SESSION_SECRET is set; nothing stored");
  } else {
    const file = path.join(v2Dir, "session.secret");
    if (fs.existsSync(file)) {
      const stored = fs.readFileSync(file, "utf-8").trim();
      if (stored.length < MIN_SESSION_SECRET_LENGTH) {
        // Never replace a secret file: a damaged one is the operator's to look at, not ours to overwrite.
        throw new Error(`${file} exists but holds no usable secret (under ${MIN_SESSION_SECRET_LENGTH} characters); fix or remove it, or set SESSION_SECRET`);
      }
      secret = stored;
      sessionSecret = "existing";
      log("session secret: kept the deployment's stored secret");
    } else {
      secret = generateSessionSecret();
      fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
      chown(file, APP_UID, APP_GID);
      sessionSecret = "generated";
      log("session secret: generated a new random secret for this deployment (data/v2/session.secret)");
    }
  }

  let runnerSecret: InitResult["runnerSecret"];
  if ((env.RUNNER_SECRET ?? "").trim()) {
    runnerSecret = "operator";
    log("runner secret: RUNNER_SECRET is set; no file written");
  } else {
    fs.mkdirSync(path.dirname(runnerSecretFile), { recursive: true });
    const temporary = `${runnerSecretFile}.tmp`;
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, deriveRunnerSecret(secret), { mode: 0o400 });
    chown(temporary, APP_UID, APP_GID);
    fs.renameSync(temporary, runnerSecretFile);
    runnerSecret = "written";
    log("runner secret: written for the subscription runner");
  }
  return { dataDirHandedOver, sessionSecret, runnerSecret };
}
