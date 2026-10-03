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

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable.
 * Handles `::` compression, an embedded dotted-quad tail (`::ffff:1.2.3.4`)
 * and a zone suffix (`fe80::1%eth0`). The WHATWG URL parser hands us the
 * canonical HEX form (`::ffff:7f00:1`), so prefix matching on the dotted
 * spelling alone was a bypass.
 */
function expandV6(addr: string): number[] | null {
  const zoneless = addr.split("%")[0]!.toLowerCase();
  const halves = zoneless.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    const tokens = part.split(":");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (i === tokens.length - 1 && token.includes(".")) {
        // embedded IPv4 tail → two groups
        if (isIP(token) !== 4) return null;
        const octets = token.split(".").map(Number);
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function embeddedV4(groups: number[], hi: number, lo: number): string {
  return `${groups[hi]! >> 8}.${groups[hi]! & 0xff}.${groups[lo]! >> 8}.${groups[lo]! & 0xff}`;
}

// IPv6 ranges considered private. Treats fc00::/7 (ULA), fe80::/10 (link-local),
// ::1 (loopback), :: (unspecified), ff00::/8 (multicast) and 2001:db8::/32
// (documentation) as blocked, and re-checks the IPv4 carried by every
// v4-embedding range — IPv4-mapped ::ffff:0:0/96 (dotted OR hex form),
// IPv4-compatible ::/96, NAT64 64:ff9b::/96 (+ the local-use 64:ff9b:1::/48)
// and 6to4 2002::/16 — against the IPv4 table.
function isPrivateV6(addr: string): boolean {
  const groups = expandV6(addr);
  if (!groups) return true; // unparseable -- fail closed
  const [g0, g1, g2] = groups as [number, number, number];
  if ((g0 & 0xff00) === 0xff00) return true;                   // multicast ff00::/8
  if ((g0 & 0xffc0) === 0xfe80) return true;                   // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true;                   // unique-local fc00::/7
  if (g0 === 0x2001 && g1 === 0x0db8) return true;             // documentation 2001:db8::/32
  const first80Zero = groups.slice(0, 5).every((g) => g === 0);
  if (first80Zero && groups[5] === 0xffff) return isPrivateV4(embeddedV4(groups, 6, 7)); // ::ffff:a.b.c.d
  if (first80Zero && groups[5] === 0) {
    // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
    if (groups[6] === 0 && groups[7]! <= 1) return true;
    return isPrivateV4(embeddedV4(groups, 6, 7));
  }
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 0x0001) return true;                            // 64:ff9b:1::/48 local-use NAT64
    if (groups.slice(2, 6).every((g) => g === 0)) return isPrivateV4(embeddedV4(groups, 6, 7)); // NAT64 64:ff9b::/96
  }
  if (g0 === 0x2002) return isPrivateV4(embeddedV4(groups, 1, 2)); // 6to4 2002:AABB:CCDD::/48
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
