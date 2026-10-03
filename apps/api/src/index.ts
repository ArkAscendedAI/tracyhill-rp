import { createApp } from "./app/createApp";
import { seedDemoUser } from "./domain/users/seedDemoUser";

const { app, env, logger, sessionStore, stopBackgroundTimers, retrievalScoring, setup } = createApp();

if (env.exposeAuthCodes && process.env.NODE_ENV === "production") {
  throw new Error("EXPOSE_AUTH_CODES=1 is not allowed in production — verification codes would be returned in API responses");
}

if (env.seedDemoUser) {
  await seedDemoUser(env.dbFile, env.demoUsername, env.demoPassword);
}

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, dbFile: env.dbFile }, "api started");
  // A deployment with no account yet prints its one-time setup code here (first-run setup, 2026-10-01).
  setup.announce();
});

// Start the retrieval scoring worker before the first campaign turn needs it
// (2026-09-21). A start failure is not fatal: the engine scores inline and
// records a system event on every affected turn.
if (retrievalScoring.isEnabled()) {
  retrievalScoring.warm().then(
    () => logger.info("retrieval scoring worker online"),
    (err) => logger.warn({ err }, "retrieval scoring worker failed to start — scoring on the API thread until it recovers"),
  );
} else {
  logger.info("retrieval scoring worker disabled (CONTEXT_SCORING_WORKER=0) — scoring on the API thread");
}

// Graceful shutdown: `docker stop` sends SIGTERM; without a handler
// Node's default just dies, so the session store's second SQLite handle was
// never closed and its prune timer never cleared. Stop accepting, drain, close
// the store, exit — with a hard deadline so a stuck keep-alive can't stall the
// container past compose's stop grace period.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "api shutting down");
  stopBackgroundTimers();
  void retrievalScoring.shutdown();
  const deadline = setTimeout(() => {
    logger.warn("shutdown deadline reached — exiting with open connections");
    process.exit(0);
  }, 10_000);
  deadline.unref();
  server.close(() => {
    try { sessionStore.close(); } catch (err) { logger.warn({ err }, "session store close failed"); }
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
