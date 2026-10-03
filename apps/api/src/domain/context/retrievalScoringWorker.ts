// Worker-thread entry for retrieval scoring. Loaded through
// retrievalScoringWorker.boot.mjs (which registers tsx first — see there).
// Protocol: { id, job } in → { id, result } | { id, error } out; a { ready }
// message is posted once on start so the pool can log the worker coming online.
import { parentPort } from "node:worker_threads";

import { executeRetrievalScoring, type RetrievalScoringJob } from "./retrievalScoring";

if (!parentPort) throw new Error("retrievalScoringWorker must be started as a worker thread");
const port = parentPort;

port.on("message", (message: { id: number; job: RetrievalScoringJob }) => {
  try {
    port.postMessage({ id: message.id, result: executeRetrievalScoring(message.job) });
  } catch (error) {
    port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
port.postMessage({ ready: true });
