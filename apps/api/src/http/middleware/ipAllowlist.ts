import type { RequestHandler } from "express";

export function createIpAllowlist(allowedIps: string): RequestHandler {
  const trimmed = allowedIps.trim();
  if (!trimmed || trimmed === "*") return (_req, _res, next) => next(); // no allowlist or wildcard
  const allowed = new Set(trimmed.split(",").map((ip) => ip.trim()).filter(Boolean));
  allowed.add("127.0.0.1");
  allowed.add("::1");
  allowed.add("::ffff:127.0.0.1");
  return (req, res, next) => {
    const peer = req.socket.remoteAddress ?? "";
    if (!allowed.has(peer)) { res.status(403).json({ error: "forbidden" }); return; }
    next();
  };
}
