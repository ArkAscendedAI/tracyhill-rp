import session from "express-session";

import type { ApiEnv } from "../config/env";
import { SqliteSessionStore } from "./sqliteSessionStore";

export function createSessionMiddleware(env: ApiEnv) {
  const store = new SqliteSessionStore(env.dbFile);
  const middleware = session({
    name: "trp.sid",
    secret: env.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.trustProxy,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  });
  return Object.assign(middleware, { store });
}
