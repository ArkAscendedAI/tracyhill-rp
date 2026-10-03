import type { NextFunction, Request, Response } from "express";
import session from "express-session";

import type { ApiEnv } from "../config/env";
import { SqliteSessionStore } from "./sqliteSessionStore";

/**
 * Session expiry is anchored to 3 AM in the server's time zone setting, NOT to login time.
 *
 * The original design was a 7-day maxAge stamped once at login (rolling unset).
 * That is a fuse: you log in when you're active, so login + 7 days lands during
 * your active hours BY CONSTRUCTION — and on 2026-07-30 it did, ejecting a
 * user mid-composition exactly 7 days after their login and destroying ten
 * paragraphs of typed work. A login-anchored expiry practically guarantees the
 * interruption it causes.
 *
 * Since 2026-07-30 expiry happens at a fixed quiet hour (3 AM unless the settings
 * say otherwise) and never at an hour derived from when someone happened to log in.
 *
 * Mechanics: every authenticated response re-stamps the cookie (rolling) to the
 * next 3 AM America/New_York at least MIN_RUNWAY away. The runway is what keeps
 * a night-owl session safe: at 1 AM the "next" 3 AM is two hours out, so the
 * stamp skips to TOMORROW's 3 AM — an active session can never be beheaded by
 * the boundary it is approaching. Consequences of the model:
 *   - Activity before ~11 PM, then sleep → cookie dies at 3 AM; next visit logs
 *     in fresh. Login is a morning event, never a mid-scene one.
 *   - A tab left open keeps polling, keeps re-stamping, and stays signed in —
 *     which also preserves any composer draft sitting in it.
 *   - The store row slides with the cookie (touch derives from cookie.maxAge),
 *     and the store's read path enforces expiry server-side, so a stale cookie
 *     cannot outlive its row.
 */
export const SESSION_EXPIRY_HOUR = 3;
export const SESSION_EXPIRY_TZ = "America/New_York";
export const SESSION_MIN_RUNWAY_MS = 4 * 60 * 60 * 1000;

/**
 * The sign-out hour and zone are server settings (Admin: Server settings → Sessions): servers that
 * predate the setting keep 3 AM America/New_York; a new server takes the zone of the browser that ran first-run setup.
 * Until the settings service configures it (and in unit tests), the built-in 3 AM America/New_York applies.
 */
export type SessionExpiryConfig = { signOutHour: number; timeZone: string };

let expiryConfig: SessionExpiryConfig = { signOutHour: SESSION_EXPIRY_HOUR, timeZone: SESSION_EXPIRY_TZ };
let partsFmt = createPartsFormat(SESSION_EXPIRY_TZ);

export function configureSessionExpiry(config: SessionExpiryConfig) {
  partsFmt = createPartsFormat(config.timeZone);
  expiryConfig = { ...config };
}

export function sessionExpiryConfig(): SessionExpiryConfig {
  return { ...expiryConfig };
}

/** True when the runtime knows the IANA zone name (Intl throws a RangeError on an unknown one). */
export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function createPartsFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

type ZoneParts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function zoneParts(at: Date): ZoneParts {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(at)) p[part.type] = part.value;
  // Intl renders midnight as "24" in some ICU versions with hour12:false — normalize.
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** The zone's offset from UTC at an instant, in ms (local wall clock minus UTC). */
function zoneOffsetMs(at: Date) {
  const p = zoneParts(at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant the zone's wall clock reads `hour`:00 on a local calendar day, or null when that time does not exist
 * there (a spring-forward gap). Two offset corrections settle every zone, half-hour and 45-minute offsets included.
 */
function zonedInstant(local: { y: number; m: number; d: number }, hour: number): Date | null {
  const wall = Date.UTC(local.y, local.m - 1, local.d, hour);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetMs(new Date(guess));
    if (next === guess) break;
    guess = next;
  }
  const candidate = new Date(guess);
  const rendered = zoneParts(candidate);
  if (rendered.y !== local.y || rendered.m !== local.m || rendered.d !== local.d || rendered.h !== hour || rendered.mi !== 0) return null;
  return candidate;
}

/**
 * The next sign-out hour in the configured zone at least SESSION_MIN_RUNWAY_MS away (3 AM America/New_York unless
 * the settings say otherwise). A day whose sign-out hour falls in a spring-forward gap is skipped; in a fall-back
 * hour the instant the offset correction settles on is used.
 */
export function nextSessionExpiry(now: Date = new Date()): Date {
  // Candidate days walk the LOCAL calendar: adding whole
  // UTC days to `now` and re-rendering in-zone skipped a calendar day when the
  // +48 h step crossed the spring-forward gap (3/7 → 3/9), so 3/8's 3 AM was
  // never tried and the stamp landed ~51 h out instead of on the next 3 AM.
  const today = zoneParts(now);
  for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
    // Date.UTC normalizes day overflow (Mar 31 + 1 → Apr 1) for us.
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + dayOffset));
    const candidate = zonedInstant({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() }, expiryConfig.signOutHour);
    if (candidate && candidate.getTime() - now.getTime() >= SESSION_MIN_RUNWAY_MS) return candidate;
  }
  // Unreachable: within any 4-day span a valid sign-out hour beyond the runway exists.
  return new Date(now.getTime() + 86_400_000);
}

/**
 * Stamp a session's cookie with the 3 AM anchor. The middleware below applies
 * it on every request; the three paths that ELEVATE a session (login without
 * MFA, MFA verify, registration verify) must apply it again after
 * `req.session.regenerate()`, because regenerate builds a fresh cookie from the
 * `maxAge` option — login + 24 h — and that is what the elevating response and
 * the store row carried until the next request re-stamped them. A
 * client whose only request was the login kept a 24-hour session.
 */
export function stampSessionExpiry(sess: session.Session & Partial<session.SessionData>): void {
  sess.cookie.expires = nextSessionExpiry();
}

export function createSessionMiddleware(env: ApiEnv) {
  const store = new SqliteSessionStore(env.dbFile);
  const sessionHandler = session({
    name: "trp.sid",
    secret: env.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    // rolling re-sends the cookie on every response; the stamper below decides
    // what expiry that cookie carries. maxAge here is only the option
    // express-session uses to build a NEW cookie (session creation and every
    // regenerate()); the request stamper and stampSessionExpiry in the
    // elevation paths replace it before the response goes out.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.trustProxy,
      maxAge: 1000 * 60 * 60 * 24,
    },
  });
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    sessionHandler(req, res, (err?: unknown) => {
      if (!err && req.session) stampSessionExpiry(req.session);
      next(err as Parameters<NextFunction>[0]);
    });
  };
  return Object.assign(middleware, { store });
}
