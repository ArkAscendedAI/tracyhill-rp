import path from "node:path";

import { createLogger } from "@tracyhill-rp/logging";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";

import { initSystemEvents } from "../../api/src/domain/system/systemEvents";
import { PipelineWorker } from "./pipeline/pipelineWorker";
import { WizardWorker } from "./wizard/wizardWorker";

const logger = createLogger("tracyhill-rp-v2-worker");
const dbFile = process.env.DB_FILE ?? path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite");
const intervalMs = Number(process.env.PIPELINE_POLL_MS ?? 1000);
const runtimeDefaults = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeCodeBridgeUrl: process.env.CLAUDE_CODE_BRIDGE_URL ?? "",
  claudeCodeBridgeSecret: process.env.CLAUDE_CODE_BRIDGE_SECRET ?? "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xiaomiApiKey: process.env.XIAOMI_API_KEY ?? "",
  zaiApiKey: process.env.ZAI_API_KEY ?? "",
};
const runtime = process.env.MOCK_PROVIDER === "1" ? null : undefined;
// No-silent-failures: without this, the standalone (non-inline) worker
// topology pino-logged failures but never persisted system events.
migrateDatabase(dbFile);
initSystemEvents(createDatabaseClient(dbFile).db);
const worker = new PipelineWorker(dbFile, { runtime, runtimeDefaults });
const wizardWorker = new WizardWorker(dbFile, { runtime, runtimeDefaults });

logger.info({ dbFile, intervalMs, runtimeConfigured: Boolean(runtime) }, "worker started");
worker.kick();
wizardWorker.kick();
setInterval(() => {
  worker.kick();
  wizardWorker.kick();
}, intervalMs);
