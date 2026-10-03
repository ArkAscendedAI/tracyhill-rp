import fs from "node:fs";
import path from "node:path";

import { createLogger } from "@tracyhill-rp/logging";

import { beatHeartbeat, createDatabaseClient, migrateDatabase, WORKER_SERVICE } from "@tracyhill-rp/db";
import { createMockChatRuntime, resolveRunnerConnection } from "@tracyhill-rp/provider-runtime";

import { createDatabaseSharedKeyReader, withSharedKeys } from "../../api/src/domain/settings/sharedKeys";
import { initSystemEvents, recordSystemEvent } from "../../api/src/domain/system/systemEvents";
import { initWorkerEncryption, parsePollIntervalMs } from "./lib/bootstrap";
import { findWedgedQueuedRuns } from "./lib/liveness";
import { PipelineWorker } from "./pipeline/pipelineWorker";
import { WizardWorker } from "./wizard/wizardWorker";

const logger = createLogger("tracyhill-rp-v2-worker");
// Per-user provider keys are AES-encrypted with a SESSION_SECRET-derived key.
// The inline topology inherited initEncryptionKey() from createApp; a dedicated
// worker process must initialize it itself or every run that builds a user
// runtime dies at decrypt. Fail loud at
// boot — a restart-looping container is visible, per-run decrypt errors hide.
let sessionSecret = "";
try {
  sessionSecret = initWorkerEncryption(process.env);
} catch (err) {
  logger.error({ err }, "worker bootstrap failed");
  process.exit(1);
}
const dbFile = process.env.DB_FILE ?? path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite");
// Validated, never `Number(raw)`: an empty/garbage PIPELINE_POLL_MS
// used to yield a 1 ms hot poll with NO heartbeat cadence → healthcheck
// restart loop. The warning (if any) rides the boot attestation below.
const { intervalMs, warning: pollWarning } = parsePollIntervalMs(process.env.PIPELINE_POLL_MS);
const runtimeDefaults = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // The runner secret derives from the resolved session secret, stored or operator-set (2026-10-01).
  ...resolveRunnerConnection({ ...process.env, SESSION_SECRET: sessionSecret }),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  fireworksApiKey: process.env.FIREWORKS_API_KEY ?? "",
  gmicloudApiKey: process.env.GMICLOUD_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? "",
  moonshotApiKey: process.env.MOONSHOT_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xiaomiApiKey: process.env.XIAOMI_API_KEY ?? "",
  zaiApiKey: process.env.ZAI_API_KEY ?? "",
  localEmbeddingUrl: process.env.LOCAL_EMBEDDING_URL ?? "",
  localEmbeddingKey: process.env.LOCAL_EMBEDDING_KEY ?? "",
};
// MOCK_PROVIDER=1: the pipeline kinds get a real mock chat runtime
// (as createApp injects for the API's chat path), so no paid call leaves a
// fixture worker; the wizard keeps `null`, its own explicit-mock sentinel
// (wizardWorker.ts) that selects its deterministic stub. Before this the
// pipeline workers received `null`, which every one of them reads as "build
// the user's runtime from stored keys" — the boot attestation said mock:true
// while rolling diffs/trackers/audits made real calls.
const mockProvider = process.env.MOCK_PROVIDER === "1";
// No-silent-failures: without this, the standalone (non-inline) worker
// topology pino-logged failures but never persisted system events.
migrateDatabase(dbFile);
const { db } = createDatabaseClient(dbFile);
initSystemEvents(db);
// The server-wide API keys set in Admin: Server settings reach every run here too, read from the database
// every few seconds; a key in this process's environment wins, as in the API.
const runtimeDefaultsWithShared = withSharedKeys(runtimeDefaults, createDatabaseSharedKeyReader(db));
const worker = new PipelineWorker(dbFile, { runtime: mockProvider ? createMockChatRuntime() : undefined, runtimeDefaults: runtimeDefaultsWithShared });
const wizardWorker = new WizardWorker(dbFile, { runtime: mockProvider ? null : undefined, runtimeDefaults: runtimeDefaultsWithShared });

// ── Liveness ────────────────────────────────────────────────────────────────
// Heartbeat row every BEAT_EVERY polls + a touch file for the container
// healthcheck; wedge scan every WEDGE_EVERY polls. A dead loop must be loudly
// distinguishable from an idle one. The compose healthcheck fails at a 90 s
// stale touch file (start_period 45 s); BEAT_EVERY keeps the beat at ~15 s for
// any interval up to that, and intervalMs is guaranteed finite and ≥ 50 ms by
// parsePollIntervalMs, so both cadences are always computable.
// Blank means the default, as in the Compose healthcheck that reads the same variable.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE?.trim() || "/tmp/worker-heartbeat";
const BEAT_EVERY = Math.max(1, Math.round(15_000 / intervalMs));
const WEDGE_EVERY = Math.max(1, Math.round(5 * 60_000 / intervalMs));
const reportedWedges = new Set<string>();

function beat() {
  try { beatHeartbeat(db, WORKER_SERVICE, { pid: process.pid, intervalMs }); } catch (err) { logger.warn({ err }, "heartbeat write failed"); }
  // Run liveness rides the same beat (2026-09-27): every run this process holds
  // stays fresh for the 60-min stale sweep, independent of its stage beats.
  try { worker.touchActiveRuns(); } catch (err) { logger.warn({ err, active: worker.activeRunCount }, "active-run liveness touch failed"); }
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch { /* container healthcheck degrades, DB row still beats */ }
}

function scanForWedges() {
  try {
    for (const wedge of findWedgedQueuedRuns(db)) {
      if (reportedWedges.has(wedge.id)) continue;
      reportedWedges.add(wedge.id);
      recordSystemEvent({
        userId: wedge.userId, source: "pipeline", severity: "error",
        campaignId: wedge.campaignId || null,
        message: `pipeline run wedged in queue: ${wedge.kind} requested ${wedge.requestedAt} still queued (${wedge.reason}) — the worker loop may be dead or the queue jammed`,
        details: wedge,
      });
      logger.error({ wedge }, "wedged queued run detected");
    }
  } catch (err) { logger.warn({ err }, "wedge scan failed"); }
}

logger.info({ dbFile, intervalMs, mockProvider }, "worker started");
if (pollWarning) logger.warn({ raw: process.env.PIPELINE_POLL_MS }, pollWarning);
// Boot attestation: state the effective reality once, loudly, in the same
// place operators already look (the system-events panel).
recordSystemEvent({
  userId: "__system__", source: "pipeline", severity: pollWarning ? "warn" : "info",
  message: `boot: dedicated worker online — poll=${intervalMs}ms, heartbeat every ${BEAT_EVERY} polls, encryption initialized${pollWarning ? ` (${pollWarning})` : ""}`,
  details: { pid: process.pid, mock: mockProvider, pollWarning },
});
beat();
worker.kick();
wizardWorker.kick();
let tick = 0;
const loop = setInterval(() => {
  tick++;
  worker.kick();
  wizardWorker.kick();
  if (tick % BEAT_EVERY === 0) beat();
  if (tick % WEDGE_EVERY === 0) scanForWedges();
}, intervalMs);

// ── Shutdown ────────────────────────────────────────────────────────────────
// Every deploy (`compose up -d --remove-orphans`) SIGTERMs this process with
// the default 10 s stop grace. Correctness never depended on a handler — rows
// left `running` are requeued by the next boot's orphan recovery, checkpoint
// intact — but with no handler the loop kept picking up NEW work until the
// SIGKILL, and an idle worker still made docker wait the full grace. Now: stop
// admitting work, let in-flight runs finish for up to the grace budget (an
// apply phase mid-write is what the apply transactions protect), then exit.
// Deliberately NOT aborting the runs: abort → canceled is terminal and would
// discard a resumable audit checkpoint.
const SHUTDOWN_GRACE_MS = 8_000;
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(loop);
  worker.stop();
  wizardWorker.stop();
  const inFlight = worker.activeRunCount + wizardWorker.activeRunCount;
  logger.info({ signal, inFlight }, "worker shutting down — no new runs will be admitted");
  const startedAt = Date.now();
  const poll = setInterval(() => {
    const remaining = worker.activeRunCount + wizardWorker.activeRunCount;
    if (remaining === 0 || Date.now() - startedAt >= SHUTDOWN_GRACE_MS) {
      clearInterval(poll);
      if (remaining > 0) {
        logger.warn({ signal, remaining }, "worker exiting with runs still in flight — they stay `running` and the next boot requeues them");
      }
      process.exit(0);
    }
  }, 100);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

// An unhandled rejection still crashes the process (Node's default, and the
// right call — the container restarts and boot recovery requeues), but it must
// be LOUD in the same place operators look, not only in the container log.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection in the worker — exiting");
  try {
    recordSystemEvent({
      userId: "__system__", source: "pipeline", severity: "error",
      message: `worker crashed on an unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      details: { pid: process.pid, stack: reason instanceof Error ? reason.stack ?? null : null },
    });
  } catch { /* the log line above already carries it */ }
  process.exit(1);
});
