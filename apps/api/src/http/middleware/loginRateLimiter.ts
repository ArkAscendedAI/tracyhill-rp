const PRUNE_INTERVAL_MS = 60 * 1000;
// Memory ceiling per map. A username-spray (or a botnet of source IPs) grows
// each map by one entry per distinct key until the lockout window prunes it;
// bound it so the limiter can't be used to exhaust the process instead.
const MAX_TRACKED_KEYS = 10_000;

type FailureRecord = { count: number; lastFailure: number };

// Canonical keys: the account lookup is COLLATE
// NOCASE, so `demo`/`Demo`/`DEMO` are ONE account and must share ONE failure
// budget — keyed on the raw string they were 2^n independent budgets. IPs are
// folded the same way: Node hands us `::ffff:1.2.3.4` or `1.2.3.4` depending on
// the listening socket family, and those must not be two counters either.
function usernameKey(username: string) {
  return username.trim().toLowerCase();
}

export function canonicalIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped ? mapped[1]! : lower;
}

// --- Login rate limiter ---
// Lock primarily on username (strict); keep a much looser IP ceiling so a
// shared home NAT (TRUST_PROXY collapses a whole home network to one public IP) isn't
// locked out for everyone by a few failures across different accounts.
const LOGIN_MAX_FAILURES_USERNAME = 5;
const LOGIN_MAX_FAILURES_IP = 30;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

const loginByIp = new Map<string, FailureRecord>();
const loginByUsername = new Map<string, FailureRecord>();

function prune(map: Map<string, FailureRecord>, lockoutMs: number) {
  const cutoff = Date.now() - lockoutMs;
  for (const [key, record] of map) {
    if (record.lastFailure < cutoff) map.delete(key);
  }
}

function bump(map: Map<string, FailureRecord>, key: string, lockoutMs: number) {
  const record = map.get(key) ?? { count: 0, lastFailure: 0 };
  record.count++;
  record.lastFailure = Date.now();
  map.set(key, record);
  if (map.size > MAX_TRACKED_KEYS) {
    prune(map, lockoutMs);
    // Still over after pruning stale entries: evict the oldest-inserted keys.
    // Map iteration is insertion-ordered, so the front of the map is the
    // longest-tracked (and therefore least useful) set of records.
    for (const oldest of map.keys()) {
      if (map.size <= MAX_TRACKED_KEYS) break;
      map.delete(oldest);
    }
  }
}

setInterval(() => {
  prune(loginByIp, LOGIN_LOCKOUT_MS);
  prune(loginByUsername, LOGIN_LOCKOUT_MS);
  prune(endpointByKey, ENDPOINT_LOCKOUT_MS);
}, PRUNE_INTERVAL_MS).unref?.();

function isLockedOut(record: FailureRecord | undefined, maxFailures: number, lockoutMs: number): boolean {
  if (!record || record.count < maxFailures) return false;
  return Date.now() - record.lastFailure < lockoutMs;
}

export function checkLoginRateLimit(ip: string, username: string): string | null {
  if (isLockedOut(loginByUsername.get(usernameKey(username)), LOGIN_MAX_FAILURES_USERNAME, LOGIN_LOCKOUT_MS)) return "too many login attempts — try again later";
  if (isLockedOut(loginByIp.get(canonicalIp(ip)), LOGIN_MAX_FAILURES_IP, LOGIN_LOCKOUT_MS)) return "too many login attempts — try again later";
  return null;
}

export function recordLoginFailure(ip: string, username: string) {
  bump(loginByIp, canonicalIp(ip), LOGIN_LOCKOUT_MS);
  bump(loginByUsername, usernameKey(username), LOGIN_LOCKOUT_MS);
}

export function clearLoginFailures(ip: string, username: string) {
  loginByIp.delete(canonicalIp(ip));
  loginByUsername.delete(usernameKey(username));
}

// --- General endpoint rate limiter (MFA, registration, password reset) ---
const ENDPOINT_MAX_ATTEMPTS = 10;
const ENDPOINT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// One budget per FLOW per IP: every step of the
// registration, password-reset, MFA and email-change flows is now counted, so
// a single shared bucket would let one family member's fumbled registration
// (register + two resends + three verifies) lock a shared home NAT out of a
// password reset. Flows are independent budgets instead. "setup" counts wrong first-run setup codes (2026-10-01).
export type EndpointRateLimitBucket = "registration" | "password-reset" | "mfa" | "email-change" | "setup";

const endpointByKey = new Map<string, FailureRecord>();

function endpointKey(ip: string, bucket: EndpointRateLimitBucket) {
  return `${bucket}:${canonicalIp(ip)}`;
}

/**
 * Rate limit by IP + flow for sensitive endpoints (MFA verify, registration, password reset).
 * Returns an error string if the IP is locked out of that flow, null otherwise.
 * Call recordEndpointAttempt() after each attempt (success or failure).
 */
export function checkEndpointRateLimit(ip: string, bucket: EndpointRateLimitBucket): string | null {
  if (isLockedOut(endpointByKey.get(endpointKey(ip, bucket)), ENDPOINT_MAX_ATTEMPTS, ENDPOINT_LOCKOUT_MS)) {
    return "too many attempts — try again later";
  }
  return null;
}

export function recordEndpointAttempt(ip: string, bucket: EndpointRateLimitBucket) {
  bump(endpointByKey, endpointKey(ip, bucket), ENDPOINT_LOCKOUT_MS);
}

/**
 * Test-only: the maps are module singletons, so route tests in one vitest file
 * would otherwise share (and eventually exhaust) a single per-IP budget.
 */
export function resetRateLimitersForTests() {
  loginByIp.clear();
  loginByUsername.clear();
  endpointByKey.clear();
}
