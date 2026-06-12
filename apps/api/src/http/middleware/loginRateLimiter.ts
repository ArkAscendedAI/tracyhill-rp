const PRUNE_INTERVAL_MS = 60 * 1000;

type FailureRecord = { count: number; lastFailure: number };

// --- Login rate limiter ---
const LOGIN_MAX_FAILURES = 3;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

const loginByIp = new Map<string, FailureRecord>();
const loginByUsername = new Map<string, FailureRecord>();

function prune(map: Map<string, FailureRecord>, lockoutMs: number) {
  const cutoff = Date.now() - lockoutMs;
  for (const [key, record] of map) {
    if (record.lastFailure < cutoff) map.delete(key);
  }
}

setInterval(() => {
  prune(loginByIp, LOGIN_LOCKOUT_MS);
  prune(loginByUsername, LOGIN_LOCKOUT_MS);
  prune(endpointByIp, ENDPOINT_LOCKOUT_MS);
}, PRUNE_INTERVAL_MS).unref?.();

function isLockedOut(record: FailureRecord | undefined, maxFailures: number, lockoutMs: number): boolean {
  if (!record || record.count < maxFailures) return false;
  return Date.now() - record.lastFailure < lockoutMs;
}

export function checkLoginRateLimit(ip: string, username: string): string | null {
  if (isLockedOut(loginByIp.get(ip), LOGIN_MAX_FAILURES, LOGIN_LOCKOUT_MS)) return "too many login attempts — try again later";
  if (isLockedOut(loginByUsername.get(username), LOGIN_MAX_FAILURES, LOGIN_LOCKOUT_MS)) return "too many login attempts — try again later";
  return null;
}

export function recordLoginFailure(ip: string, username: string) {
  for (const [map, key] of [[loginByIp, ip], [loginByUsername, username]] as const) {
    const record = map.get(key) ?? { count: 0, lastFailure: 0 };
    record.count++;
    record.lastFailure = Date.now();
    map.set(key, record);
  }
}

export function clearLoginFailures(ip: string, username: string) {
  loginByIp.delete(ip);
  loginByUsername.delete(username);
}

// --- General endpoint rate limiter (MFA, registration, password reset) ---
const ENDPOINT_MAX_ATTEMPTS = 10;
const ENDPOINT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const endpointByIp = new Map<string, FailureRecord>();

/**
 * Rate limit by IP for sensitive endpoints (MFA verify, registration, password reset).
 * Returns an error string if the IP is locked out, null otherwise.
 * Call recordEndpointAttempt() after each attempt (success or failure).
 */
export function checkEndpointRateLimit(ip: string): string | null {
  if (isLockedOut(endpointByIp.get(ip), ENDPOINT_MAX_ATTEMPTS, ENDPOINT_LOCKOUT_MS)) {
    return "too many attempts — try again later";
  }
  return null;
}

export function recordEndpointAttempt(ip: string) {
  const record = endpointByIp.get(ip) ?? { count: 0, lastFailure: 0 };
  record.count++;
  record.lastFailure = Date.now();
  endpointByIp.set(ip, record);
}
