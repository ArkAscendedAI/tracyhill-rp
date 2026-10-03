import type { RequestHandler } from "express";

import { canonicalIp } from "./loginRateLimiter";

/**
 * Exact-match allowlist on the upstream TCP peer (`socket.remoteAddress`).
 * Entries are plain IPs — NOT CIDRs (the .env template used to claim
 * otherwise). Both the list and the peer are folded through
 * canonicalIp, so `::ffff:192.168.1.10` and `192.168.1.10` are one entry and an
 * operator no longer has to list every address in both spellings.
 */
export function createIpAllowlist(allowedIps: string): RequestHandler {
  const trimmed = allowedIps.trim();
  if (!trimmed || trimmed === "*") return (_req, _res, next) => next(); // no allowlist or wildcard
  const allowed = new Set(trimmed.split(",").map((ip) => canonicalIp(ip)).filter(Boolean));
  allowed.add("127.0.0.1");
  allowed.add("::1");
  return (req, res, next) => {
    const peer = canonicalIp(req.socket.remoteAddress ?? "");
    if (!allowed.has(peer)) { res.status(403).json({ error: "forbidden" }); return; }
    next();
  };
}
