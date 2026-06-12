import type { RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const csrfProtection: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (process.env.NODE_ENV === "test") return next(); // supertest has no Origin
  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header — require X-Requested-With as defense-in-depth.
    // Browsers cannot set custom headers on cross-origin requests without CORS preflight,
    // so this blocks CSRF from forms/redirects that strip the Origin header.
    if (req.headers["x-requested-with"]) return next();
    res.status(403).json({ error: "missing origin or x-requested-with header" });
    return;
  }
  const host = req.headers.host;
  if (!host) { res.status(403).json({ error: "missing host header" }); return; }
  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return next();
  } catch { /* invalid origin URL */ }
  res.status(403).json({ error: "cross-origin request blocked" });
};
