import { readStoredSessionSecret } from "../../../api/src/config/sessionSecret";
import { initEncryptionKey } from "../../../api/src/lib/crypto";

// Worker-process bootstrap, extracted from index.ts so the requirements are
// testable without importing the entrypoint's side effects (intervals,
// process.exit). The dedicated worker used to leave the provider-key
// encryption key uninitialized — the inline topology inherited
// it from createApp, a standalone process must do it itself or every run that
// builds a per-user runtime dies at decrypt.
//
// The secret is the operator's SESSION_SECRET (trimmed, as the API reads it) or,
// since 2026-10-01, the deployment's stored one: the Docker init service writes it
// before this process starts (apps/api/src/deployment/init.ts), and a bare-node API
// writes it on its first boot. The worker only reads it, so the two never diverge.
// Returns the secret, which the caller also needs to derive the runner secret.
export function initWorkerEncryption(
  env: NodeJS.ProcessEnv,
  readStored: () => string | null = () => readStoredSessionSecret(),
): string {
  const sessionSecret = (env.SESSION_SECRET ?? "").trim() || readStored() || "";
  if (!sessionSecret) {
    throw new Error(
      "No SESSION_SECRET and no stored data/v2/session.secret — the worker cannot decrypt per-user provider keys; refusing to start "
        + "(under Docker the init service creates it; on bare Node start the API first, or set SESSION_SECRET)",
    );
  }
  initEncryptionKey(sessionSecret);
  return sessionSecret;
}

export const DEFAULT_POLL_INTERVAL_MS = 1000;
// Floor: below this the loop is a hot spin; the compose healthcheck also needs
// the heartbeat cadence (15 s / interval polls) to stay computable.
export const MIN_POLL_INTERVAL_MS = 50;

/**
 * Resolve the poll interval from PIPELINE_POLL_MS. The compose
 * default (`${PIPELINE_POLL_MS:-1000}`) applies only when the variable is
 * UNSET — an empty `PIPELINE_POLL_MS=` line in the deploy-dir .env reaches the
 * process as "", and `Number("")` is 0: `setInterval(fn, 0)` spins at 1 ms
 * while `BEAT_EVERY = round(15000 / 0) = Infinity` means `tick % Infinity` is
 * never 0, so the only heartbeat is the boot one, the touch file goes stale at
 * 90 s and the container restart-loops. "abc" → NaN → the same outcome.
 * Anything unparseable, non-finite or below the floor falls back to the
 * default; `warning` says why so the boot attestation can carry it.
 */
export function parsePollIntervalMs(raw: string | undefined): { intervalMs: number; warning: string | null } {
  if (raw === undefined || raw.trim() === "") {
    return { intervalMs: DEFAULT_POLL_INTERVAL_MS, warning: raw === undefined ? null : `PIPELINE_POLL_MS is set but empty — using ${DEFAULT_POLL_INTERVAL_MS}ms` };
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    return { intervalMs: DEFAULT_POLL_INTERVAL_MS, warning: `PIPELINE_POLL_MS=${JSON.stringify(raw)} is not an integer — using ${DEFAULT_POLL_INTERVAL_MS}ms` };
  }
  if (parsed < MIN_POLL_INTERVAL_MS) {
    return { intervalMs: DEFAULT_POLL_INTERVAL_MS, warning: `PIPELINE_POLL_MS=${parsed} is below the ${MIN_POLL_INTERVAL_MS}ms floor — using ${DEFAULT_POLL_INTERVAL_MS}ms` };
  }
  return { intervalMs: parsed, warning: null };
}
