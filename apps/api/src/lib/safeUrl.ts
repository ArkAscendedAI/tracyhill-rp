import { isIP } from "node:net";
import { promises as dns } from "node:dns";

import { HttpError } from "./httpError";

// IPv4 ranges considered private / unsafe for outbound fetches from user-controlled URLs.
// Covers RFC1918, loopback, link-local, CGNAT (RFC6598), "this network", and reserved.
const PRIVATE_V4_PATTERNS = [
  /^0\./,                                                  // 0.0.0.0/8 -- "this network"
  /^10\./,                                                 // RFC1918
  /^127\./,                                                // loopback
  /^169\.254\./,                                           // link-local
  /^172\.(1[6-9]|2\d|3[01])\./,                            // RFC1918 172.16.0.0/12
  /^192\.0\.0\./,                                          // protocol assignments
  /^192\.0\.2\./,                                          // TEST-NET-1
  /^192\.168\./,                                           // RFC1918
  /^198\.(1[89])\./,                                       // benchmarking
  /^198\.51\.100\./,                                       // TEST-NET-2
  /^203\.0\.113\./,                                        // TEST-NET-3
  /^22[4-9]\.|^23\d\./,                                    // multicast (224-239)
  /^24\d\.|^25[0-5]\./,                                    // reserved + broadcast (240-255)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,              // RFC6598 CGNAT 100.64.0.0/10
];

// IPv6 ranges considered private. Treats fc00::/7 (ULA), fe80::/10 (link-local),
// ::1 (loopback), :: (unspecified), and ff00::/8 (multicast) as blocked.
function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("ff")) return true;             // multicast
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;  // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;   // unique-local fc00::/7
  if (/^::ffff:/.test(lower)) {
    // IPv4-mapped: extract the v4 portion and re-check
    const v4 = lower.slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateV4(v4);
  }
  return false;
}

function isPrivateV4(addr: string): boolean {
  return PRIVATE_V4_PATTERNS.some((re) => re.test(addr));
}

export function isPrivateIp(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isPrivateV4(addr);
  if (family === 6) return isPrivateV6(addr);
  return true; // unknown -- fail closed
}

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
  "gateway.docker.internal",
  "broadcasthost",
]);

/**
 * Validates that a hostname (or IP literal) resolves to a public, routable address.
 * Throws HttpError(400, ...) on rejection.
 *
 * Allowlist escape hatch: hostnames listed in `allowedHosts` skip the IP check entirely.
 * Useful for opt-in LAN endpoints (LM Studio, Ollama, etc.). Per-deployment env var.
 *
 * Note: this is create-time validation only. DNS rebinding at fetch-time is mitigated
 * by the schema-level `https://` requirement (attacker needs a valid TLS cert for the
 * rebound hostname, which is hard).
 */
export async function assertPublicHostname(
  hostname: string,
  allowedHosts: ReadonlySet<string>,
): Promise<void> {
  const normalized = hostname.toLowerCase().trim();
  if (!normalized) throw new HttpError(400, "Custom endpoint baseUrl has empty hostname");
  if (allowedHosts.has(normalized)) return;

  if (LOCAL_HOSTNAMES.has(normalized)) {
    throw new HttpError(400, "Custom endpoint baseUrl resolves to a local host");
  }

  // IP literal
  const ipFamily = isIP(normalized.replace(/^\[|\]$/g, ""));
  if (ipFamily !== 0) {
    if (isPrivateIp(normalized.replace(/^\[|\]$/g, ""))) {
      throw new HttpError(400, "Custom endpoint baseUrl resolves to a private IP");
    }
    return;
  }

  // Hostname -- resolve DNS and reject if any answer is private
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(normalized, { all: true });
  } catch {
    throw new HttpError(400, "Custom endpoint baseUrl hostname could not be resolved");
  }
  if (records.length === 0) {
    throw new HttpError(400, "Custom endpoint baseUrl hostname could not be resolved");
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new HttpError(400, "Custom endpoint baseUrl resolves to a private IP");
    }
  }
}

export function parseAllowedHosts(csv: string): ReadonlySet<string> {
  return new Set(
    csv
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}
