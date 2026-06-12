const MAX_RETRIES = 2;
const BACKOFF_MS = [30_000, 60_000];

export function isTransientApiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes("overloaded") || msg.includes("529")) return true;
  if (msg.includes("rate") && msg.includes("limit")) return true;
  if (msg.includes("503") || msg.includes("service unavailable")) return true;
  if (msg.includes("econnreset") || msg.includes("socket") || msg.includes("network")) return true;
  if (msg.includes("terminated") || msg.includes("premature close")) return true;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, reset?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isTransientApiError(err)) throw err;
      reset?.();
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
}
