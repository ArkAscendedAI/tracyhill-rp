import { getProviderHttpStatus } from "@tracyhill-rp/provider-runtime";

const MAX_RETRIES = 2;
const BACKOFF_MS = [30_000, 60_000];

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

// A refused or reset connection, a temporary DNS failure and an undici socket
// close: a sidecar or runner restart is
// seconds long and the 30 s / 60 s backoff covers it. On 2026-09-09 a
// sidecar restart failed five runs of one campaign at once with
// "connect ECONNREFUSED …:7701" and "Codex App Server stopped", none retried.
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "UND_ERR_SOCKET"]);
const CAUSE_DEPTH = 3;

/** The error and up to three levels of `cause` — Node's fetch reports every
 *  transport failure as a bare "fetch failed" TypeError and puts the reason
 *  (an Error with `code`, e.g. ECONNREFUSED or UND_ERR_SOCKET) in `cause`;
 *  node:http puts `code` on the error itself. */
function errorChain(error: Error): unknown[] {
  const chain: unknown[] = [error];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; cause && depth < CAUSE_DEPTH; depth++) {
    chain.push(cause);
    cause = (cause as { cause?: unknown }).cause;
  }
  return chain;
}

function isTransientNetworkFailure(error: Error): boolean {
  const chain = errorChain(error);
  // A cancel is never a network failure, whatever it is wrapped in.
  if (chain.some((link) => (link as { name?: unknown })?.name === "AbortError")) return false;
  return chain.some((link) => {
    const code = (link as { code?: unknown })?.code;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
    const message = link instanceof Error ? link.message : typeof link === "string" ? link : "";
    return /\b(?:ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR_SOCKET)\b/i.test(message);
  });
}

// Laddered cooldown for a self-requeuing run (campaign audit resume). Sized for
// Max-window / provider-outage recovery: minutes, not seconds — the run has a
// checkpoint, so waiting costs nothing but wall-clock. Index = prior attempts.
const RESUME_COOLDOWN_MS = [5, 15, 30, 60, 90, 120].map((m) => m * 60_000);
export const MAX_RESUME_ATTEMPTS = RESUME_COOLDOWN_MS.length;
export function resumeCooldownMs(priorAttempts: number): number {
  return RESUME_COOLDOWN_MS[Math.min(priorAttempts, RESUME_COOLDOWN_MS.length - 1)]!;
}

/** Should a failed worker run RETRY-BY-REQUEUE (keep its checkpoint) rather than
 *  fail terminally? Transient API trouble OR a hung-call deadline — the classes
 *  that clear on their own given time (rate limits, overload, the Max window,
 *  provider blips). A cancel is never resumable. */
export function isResumableError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (isTransientApiError(error, signal)) return true;
  if (error instanceof Error && /exceeded its \d+-minute deadline/i.test(error.message)) return true;
  if (error instanceof Error && /(quota|usage limit|too many requests|429)/i.test(error.message)) return true;
  // The agent-service v1 stall watchdog (2026-07-10) interrupts zombie bridge
  // queries and reports this string — same Max-window class as the deadline;
  // NOT in-place-retryable (each attempt would re-stall for minutes), but a
  // checkpointed requeue rides out the window.
  if (error instanceof Error && /query stalled|stall watchdog/i.test(error.message)) return true;
  return false;
}

// Module-private since 2026-09-02: consumed only by isResumableError
// and withRetry; `isResumableError` is the exported classifier.
function isTransientApiError(error: unknown, signal?: AbortSignal): boolean {
  // A canceled run must never be treated as transient — it should propagate
  // immediately, not retry through the 30s/60s backoff.
  if (isAbort(error, signal)) return false;
  if (!(error instanceof Error)) return false;
  // Structural first: a non-OK upstream response carries its HTTP
  // status (provider-runtime ProviderHttpError). 429 / 408 / any 5xx clear on
  // their own given time; every other status is the caller's problem and must
  // NOT be retried on body wording (a 400 whose text happens to say "rate
  // limit"). The wording checks below remain for non-HTTP errors (bridge/SDK
  // strings, socket failures).
  const status = getProviderHttpStatus(error);
  if (status != null) return status === 429 || status === 408 || status >= 500;
  const msg = error.message.toLowerCase();
  // Status codes as whole tokens: a substring match classified
  // "prompt is too long: 1529102 tokens > 1000000 maximum" as an overload and
  // re-sent the same over-long prompt through the backoffs on every turn.
  if (msg.includes("overloaded") || /\b529\b/.test(msg)) return true;
  if (msg.includes("rate") && msg.includes("limit")) return true;
  if (/\b503\b/.test(msg) || msg.includes("service unavailable")) return true;
  if (msg.includes("econnreset") || msg.includes("epipe") || msg.includes("broken pipe") || msg.includes("socket") || msg.includes("network")) return true;
  if (msg.includes("terminated") || msg.includes("premature close") || msg.includes("premature eof")) return true;
  // A refused or reset connection, a temporary DNS failure or an
  // undici socket close, in the message or anywhere in the cause chain ("fetch
  // failed" carrying one of them), and the Codex sidecar's App Server going
  // away mid-call ("Codex App Server stopped" / "exited (SIGTERM)"). A bare
  // "fetch failed" with no such cause (a DNS name that does not exist, a TLS
  // failure) stays terminal.
  if (isTransientNetworkFailure(error)) return true;
  if (/\bapp server (?:stopped|exited)\b/.test(msg)) return true;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, reset?: () => void, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      // Rethrow abort immediately so a canceled run skips the backoff entirely.
      if (isAbort(err, signal)) throw err;
      if (attempt >= MAX_RETRIES || !isTransientApiError(err, signal)) throw err;
      reset?.();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("aborted", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, BACKOFF_MS[attempt]);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}

// Hard per-call deadline for a worker LLM call. A hang is NOT an error — it never
// resolves — so withRetry alone can't catch it; historically only the 60-min
// stale-lock sweep did (the "47-minute hang" class). This races an inner
// AbortController timer against the run's own cancel signal, passing a COMBINED
// signal into the call. On deadline (the run itself NOT canceled) it throws a
// plain Error — deliberately NOT an AbortError — so the worker's catch treats it
// as a normal failure (markFailed → recorded system_event) rather than a cancel.
// A real run-cancel still propagates as abort and short-circuits first.
export async function withDeadline<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), ms);
  const combined = outerSignal ? AbortSignal.any([outerSignal, timer.signal]) : timer.signal;
  try {
    return await fn(combined);
  } catch (err) {
    if (timer.signal.aborted && !outerSignal?.aborted) {
      throw new Error(`${label} exceeded its ${Math.round(ms / 60_000)}-minute deadline (LLM call hung)`);
    }
    throw err;
  } finally {
    clearTimeout(handle);
  }
}

// 30 min: generous headroom for the heaviest worker calls (Mara-scale
// campaign_review deep-refresh / world-tick on a big cast can legitimately run
// long on the slow Max/CLI bridge). This MUST stay BELOW provider-runtime's
// CHAT_STREAM_TIMEOUT_MS (35 min) so THIS deadline governs and a hang surfaces as
// a clean failure (markFailed + system_event), not a provider-timeout AbortError
// that the worker catch would misclassify as a cancel. Healthy calls finish in
// seconds-to-minutes and never approach it.
// The WIZARD opted out entirely (2026-08-09): its calls run
// undeadlined with streamTimeoutMs: 0, and its Cancel is the only stop — a
// corpus generation on a big canon cast can legitimately exceed any fixed timer.
export const WORKER_LLM_DEADLINE_MS = 30 * 60_000;

// Best-effort deadline for work that can't accept a cancel signal (the shared
// EmbeddingService.indexEntries makes provider fetches with no signal param).
// Rejects if the promise doesn't settle in `ms`; the underlying call may keep
// running detached (fine for a non-fatal re-embed). The timer is cleared on
// settle so it never dangles. Prevents a hung embed from sitting until the
// 60-min stale-lock sweep — the only prior backstop.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 60_000)}m`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
