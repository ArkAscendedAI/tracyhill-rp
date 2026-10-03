import type { SubscriptionProvider } from "@tracyhill-rp/contracts";

import { HttpError } from "../../lib/httpError";

// HTTP client for the subscription runner (apps/runner): account routes only.
// Composer traffic goes through the provider runtimes, not through here.
export type RunnerAccountStatus = {
  loggedIn: boolean;
  email?: string | null;
  org?: string | null;
  plan?: string | null;
  authMethod?: string | null;
};

export type RunnerLoginStart = {
  loginId: string;
  url: string;
  userCode?: string | null;
  expiresAt: string;
  completion: "paste-code" | "poll";
};

export type RunnerLoginComplete = RunnerAccountStatus & { done: boolean; success: boolean; error?: string | null };

export type RunnerHealth = { ok: boolean; claudeVersion?: string | null; codexVersion?: string | null };

export class RunnerClient {
  constructor(
    private readonly config: { runnerUrl: string; runnerSecret: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.runnerUrl?.trim() && this.config.runnerSecret?.trim());
  }

  async health(): Promise<RunnerHealth> {
    const response = await this.fetchImpl(`${this.base()}/healthz`, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new HttpError(502, `subscription runner health returned ${response.status}`);
    return await response.json() as RunnerHealth;
  }

  status(userId: string, provider: SubscriptionProvider) {
    return this.call<RunnerAccountStatus>("GET", `/accounts/${provider}/status`, userId, undefined, 60_000);
  }

  startLogin(userId: string, provider: SubscriptionProvider, method?: string) {
    return this.call<RunnerLoginStart>("POST", `/accounts/${provider}/login/start`, userId, method ? { method } : {}, 90_000);
  }

  completeLogin(userId: string, provider: SubscriptionProvider, loginId: string, code?: string) {
    return this.call<RunnerLoginComplete>("POST", `/accounts/${provider}/login/complete`, userId, code === undefined ? { loginId } : { loginId, code }, 120_000);
  }

  cancelLogin(userId: string, provider: SubscriptionProvider, loginId: string) {
    return this.call<{ cancelled: boolean }>("POST", `/accounts/${provider}/login/cancel`, userId, { loginId }, 60_000);
  }

  logout(userId: string, provider: SubscriptionProvider) {
    return this.call<{ loggedIn: boolean }>("POST", `/accounts/${provider}/logout`, userId, {}, 90_000);
  }

  /** The user ids with a credential home on the runner (the route is not tied to one user). */
  listHomes() {
    return this.call<{ userIds: string[] }>("GET", "/homes", "system", undefined, 30_000);
  }

  private base() { return this.config.runnerUrl.replace(/\/$/, ""); }

  private async call<T>(method: "GET" | "POST", path: string, userId: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.configured) throw new HttpError(503, "subscription runner is not configured");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.runnerSecret}`,
          "x-rp-user-id": userId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `subscription runner unreachable: ${reason}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `subscription runner returned ${response.status}`;
      // The runner's own 4xx (a bad code, an expired sign-in) is the user's error;
      // anything else is the runner's.
      throw new HttpError(response.status === 400 || response.status === 404 ? response.status : 502, message);
    }
    return parsed as T;
  }
}
