// Worker-thread bootstrap for retrievalScoringWorker.ts. The API runs from
// TypeScript source under `node --import tsx`, but a worker thread does not
// inherit the parent's loader hooks: verified 2026-09-21 on Node 20 in the
// production image ("Unknown file extension .ts"), on Node 22 locally and under
// vitest. So the worker registers tsx itself (the documented `tsx/esm/api`
// route) before importing its TypeScript entry. Keep this file plain JavaScript.
import { register } from "tsx/esm/api";

register();
await import("./retrievalScoringWorker.ts");
