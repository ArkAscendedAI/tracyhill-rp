import { SUBSCRIPTION_PROVIDERS, type SubscriptionLoginStartResponse, type SubscriptionProvider, type SubscriptionsResponse, type SubscriptionStatus } from "@tracyhill-rp/contracts";
import { createLogger } from "@tracyhill-rp/logging";

import { HttpError } from "../../lib/httpError";
import { recordSystemEvent } from "../system/systemEvents";
import type { UserRepository } from "../users/userRepository";
import { ProviderConnectionRepository } from "./providerConnectionRepository";
import type { RunnerAccountStatus, RunnerClient } from "./runnerClient";
import { SERVER_SUBSCRIPTION_HOME } from "./serverConnectionRepository";
import { buildSubscriptionsResponse, rowToStatus } from "./subscriptionStatus";

const logger = createLogger("subscriptions");

// Re-verify a recorded connection against the runner at most this often when
// the Providers dialog asks for a verified read (the CLI/app-server report the
// truth; the row is the app's cache for gating).
const VERIFY_MAX_AGE_MS = 60 * 60_000;

type PendingLogin = { loginId: string; expiresAt: number };

/**
 * The app-side state machine over the runner's account routes
 * Never sees a token: the runner reports
 * loggedIn/email/plan from the official binaries, and this service records it.
 */
export class SubscriptionService {
  private readonly pendingLogins = new Map<string, PendingLogin>();
  // One verification per (user, provider) at a time: the dialog's card poll and
  // its list refresh can ask at the same moment, and a pending device-code login
  // is consumed by whichever read reaches the runner first (production,
  // 2026-09-25: the second read got "no pending sign-in" although the row had
  // just been recorded connected). Concurrent callers share the in-flight result.
  private readonly inFlight = new Map<string, Promise<SubscriptionStatus>>();
  // Counts finished logouts per (user, provider). A status check or a sign-in
  // completion that was still waiting on the runner when a logout finished must
  // not write its answer: the runner may have read the sign-in before the logout
  // revoked it, and recording that answer re-created a "connected" row the user
  // had just logged out of. The logout wins.
  private readonly logouts = new Map<string, number>();
  // Counts sign-in starts and cancels per (user, provider). A status check or
  // a code completion that was still waiting on the runner when its sign-in was
  // cancelled, or a newer one started, must not delete or write anything: its
  // pending entry is no longer the captured login.
  // It used to delete the NEW pending entry and write its late "The sign-in did
  // not finish" (or its error) onto the row the new start had just cleared, and
  // both clients' polls take any lastError for the new sign-in's failure. The
  // newer attempt wins, as a logout does; its own calls report, and a sign-in
  // the user finished anyway is recorded by the next verified read.
  private readonly attempts = new Map<string, number>();

  constructor(
    // Only findById is used; the server-wide service passes one that knows its shared home.
    private readonly users: Pick<UserRepository, "findById">,
    // The account's rows, or the server-wide ones (ServerConnectionRepository).
    private readonly connections: Pick<ProviderConnectionRepository, "listByUser" | "find" | "upsert" | "delete">,
    private readonly runner: RunnerClient,
    private readonly now: () => string = () => new Date().toISOString(),
    // The pause between sign-out attempts; tests pass one that does not wait.
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  get available(): boolean { return this.runner.configured; }

  list(userId: string): SubscriptionsResponse {
    this.assertUser(userId);
    return buildSubscriptionsResponse(this.connections.listByUser(userId), this.available);
  }

  status(userId: string, provider: SubscriptionProvider): SubscriptionStatus {
    this.assertUser(userId);
    return rowToStatus(this.connections.find(userId, provider), provider, this.available);
  }

  /** The runner's word on the sign-in, recorded; a pending ChatGPT device login is checked first. */
  async verify(userId: string, provider: SubscriptionProvider): Promise<SubscriptionStatus> {
    this.assertUser(userId);
    if (!this.available) return this.status(userId, provider);
    const key = this.pendingKey(userId, provider);
    // Shared within one sign-in attempt only: a newer attempt's read must
    // neither wait on nor take a cancelled attempt's runner check.
    const flightKey = `${key}#${this.attempts.get(key) ?? 0}`;
    const running = this.inFlight.get(flightKey);
    if (running) return running;
    const task = this.verifyNow(userId, provider).finally(() => { this.inFlight.delete(flightKey); });
    this.inFlight.set(flightKey, task);
    return task;
  }

  private async verifyNow(userId: string, provider: SubscriptionProvider): Promise<SubscriptionStatus> {
    // After every await: a logout or a newer sign-in attempt since this call began means it writes nothing.
    const stale = this.staleSince(userId, provider);
    const pending = this.pendingLogins.get(this.pendingKey(userId, provider));
    if (pending && provider === "chatgpt") {
      if (Date.now() > pending.expiresAt) {
        this.pendingLogins.delete(this.pendingKey(userId, provider));
        this.connections.upsert(userId, provider, { status: this.currentStatus(userId, provider), lastError: "The code expired. Start again." }, this.now());
        return this.status(userId, provider);
      }
      let result: Awaited<ReturnType<RunnerClient["completeLogin"]>>;
      try { result = await this.runner.completeLogin(userId, provider, pending.loginId); }
      catch (error) {
        if (stale()) return this.status(userId, provider);
        // The runner no longer knows the login (consumed by an earlier read, or a
        // runner restart): the binary's own status is the truth, so ask it.
        if (!(error instanceof HttpError && error.statusCode === 404)) throw error;
        this.pendingLogins.delete(this.pendingKey(userId, provider));
        const reported = await this.runner.status(userId, provider).catch(() => null);
        if (stale()) return this.status(userId, provider);
        if (reported?.loggedIn) return this.recordAccount(userId, provider, reported, true);
        this.connections.upsert(userId, provider, { status: this.currentStatus(userId, provider), lastError: "The sign-in did not finish. Start again." }, this.now());
        return this.status(userId, provider);
      }
      if (stale() || !result.done) return this.status(userId, provider);
      this.pendingLogins.delete(this.pendingKey(userId, provider));
      if (!result.success) {
        this.connections.upsert(userId, provider, { status: this.currentStatus(userId, provider), lastError: result.error || "sign-in failed" }, this.now());
        return this.status(userId, provider);
      }
      return this.recordAccount(userId, provider, result, true);
    }
    const existing = this.connections.find(userId, provider);
    if (!existing) return this.status(userId, provider);
    // The binary's report is the truth: a sign-in it sees becomes connected even
    // when the app never recorded the completion (the CLI finished after the
    // app's wait ran out, or the credential volume was restored); a sign-in it
    // no longer sees expires a connected row and leaves any other row as it is
    // (never a false expiry on a sign-in that was only started).
    let reported: RunnerAccountStatus;
    try { reported = await this.runner.status(userId, provider); }
    catch (error) {
      if (stale()) return this.status(userId, provider);
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ userId, provider, reason }, "subscription status could not be verified");
      // Only a connected row carries the note: its owner needs to know the
      // connection could not be confirmed. Other rows keep their own message.
      if (existing.status === "connected") this.connections.upsert(userId, provider, { status: "connected", lastError: `could not verify: ${reason}` }, this.now());
      return this.status(userId, provider);
    }
    if (stale()) return this.status(userId, provider);
    if (!reported.loggedIn) {
      if (existing.status === "connected") {
        this.connections.upsert(userId, provider, { status: "expired", lastError: "Your sign-in expired. Sign in again.", verifiedAt: this.now() }, this.now());
      }
      return this.status(userId, provider);
    }
    return this.recordAccount(userId, provider, reported, existing.status !== "connected");
  }

  /** Every recorded connection, re-verified when its last check is older than an hour. */
  async listVerified(userId: string): Promise<SubscriptionsResponse> {
    this.assertUser(userId);
    if (!this.available) return this.list(userId);
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const row = this.connections.find(userId, provider);
      const pending = this.pendingLogins.has(this.pendingKey(userId, provider));
      if (!row && !pending) continue;
      // Connected rows are re-checked hourly; any other recorded row is checked
      // on every verified read (cheap: the runner answers without spawning
      // anything for a user who has no credential home).
      const age = row?.status === "connected" && row.verifiedAt ? Date.now() - Date.parse(row.verifiedAt) : Number.POSITIVE_INFINITY;
      if (pending || !Number.isFinite(age) || age > VERIFY_MAX_AGE_MS) await this.verify(userId, provider);
    }
    return this.list(userId);
  }

  async startLogin(userId: string, provider: SubscriptionProvider, method?: string): Promise<SubscriptionLoginStartResponse> {
    this.assertUser(userId);
    this.assertAvailable();
    // A connected row refuses a new sign-in. Neither
    // card offers Connect on one, so this is a stale card, another device or a
    // direct call. The row used to stay connected, so that card's poll ended at
    // once on the old connection, the runner's device login waited out its code,
    // and the expired code's "The code expired. Start again." then stood under
    // "Connected as …" for up to an hour. The card shows this sentence.
    if (this.currentStatus(userId, provider) === "connected") throw new HttpError(409, "Already connected. Log out first.");
    this.bumpAttempt(userId, provider);
    const started = await this.runner.startLogin(userId, provider, method);
    this.pendingLogins.set(this.pendingKey(userId, provider), { loginId: started.loginId, expiresAt: Date.parse(started.expiresAt) || Date.now() + 10 * 60_000 });
    // A new sign-in replaces a lapsed one: an expired row reads "disconnected"
    // from here on, so a client polling the pending sign-in never takes the old
    // expiry for its result (the web card and Android 1.2.0 stopped on it
    // and dropped the device code). A connected row never gets here.
    this.connections.upsert(userId, provider, { status: "disconnected", lastError: null }, this.now());
    return {
      provider,
      loginId: started.loginId,
      url: started.url,
      userCode: started.userCode ?? null,
      expiresAt: started.expiresAt,
      completion: started.completion,
    };
  }

  async completeLogin(userId: string, provider: SubscriptionProvider, loginId: string, code?: string): Promise<SubscriptionStatus> {
    this.assertUser(userId);
    this.assertAvailable();
    // A completion that lands after a logout or a newer attempt answers the current status and writes
    // nothing: its error or outcome belongs to a sign-in the user has left.
    const stale = this.staleSince(userId, provider);
    let result;
    try { result = await this.runner.completeLogin(userId, provider, loginId, code); }
    catch (error) {
      if (stale()) return this.status(userId, provider);
      const reason = error instanceof HttpError ? error.message : (error instanceof Error ? error.message : String(error));
      this.pendingLogins.delete(this.pendingKey(userId, provider));
      this.connections.upsert(userId, provider, { status: this.currentStatus(userId, provider), lastError: reason }, this.now());
      throw error;
    }
    if (stale() || !result.done) return this.status(userId, provider);
    this.pendingLogins.delete(this.pendingKey(userId, provider));
    if (!result.success) {
      const reason = result.error || "sign-in failed";
      this.connections.upsert(userId, provider, { status: this.currentStatus(userId, provider), lastError: reason }, this.now());
      throw new HttpError(400, reason);
    }
    return this.recordAccount(userId, provider, result, true);
  }

  async cancelLogin(userId: string, provider: SubscriptionProvider, loginId: string): Promise<SubscriptionStatus> {
    this.assertUser(userId);
    this.bumpAttempt(userId, provider);
    this.pendingLogins.delete(this.pendingKey(userId, provider));
    if (this.available) {
      try { await this.runner.cancelLogin(userId, provider, loginId); }
      catch (error) { logger.warn({ userId, provider, reason: error instanceof Error ? error.message : String(error) }, "login cancel failed"); }
    }
    return this.status(userId, provider);
  }

  /** The provider's own logout (revokes) through the runner, then the record goes. */
  async logout(userId: string, provider: SubscriptionProvider): Promise<SubscriptionStatus> {
    this.assertUser(userId);
    this.pendingLogins.delete(this.pendingKey(userId, provider));
    if (this.available) await this.runner.logout(userId, provider);
    this.connections.delete(userId, provider);
    const key = this.pendingKey(userId, provider);
    this.logouts.set(key, (this.logouts.get(key) ?? 0) + 1);
    return this.status(userId, provider);
  }

  /** For account deletion: the runner homes go with the user. Each sign-out is tried three times; one that still fails
   *  is reported to the administrator, and removeOrphanedSignIns takes it at the API's next start. */
  async disconnectAll(userId: string): Promise<void> {
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      this.pendingLogins.delete(this.pendingKey(userId, provider));
      if (!this.available) continue;
      await this.signOutDeleted(userId, provider);
    }
  }

  /** Removes the runner sign-ins of accounts that no longer exist (a deletion whose sign-out failed). The server-wide
   *  sign-ins' home is never touched. Returns how many accounts' homes were removed. */
  async removeOrphanedSignIns(accountExists: (userId: string) => boolean): Promise<number> {
    if (!this.available) return 0;
    const { userIds } = await this.runner.listHomes();
    let removed = 0;
    for (const userId of userIds) {
      if (userId === SERVER_SUBSCRIPTION_HOME || accountExists(userId)) continue;
      let ok = true;
      for (const provider of SUBSCRIPTION_PROVIDERS) ok = (await this.signOutDeleted(userId, provider)) && ok;
      if (ok) removed += 1;
    }
    if (removed > 0) {
      recordSystemEvent({
        userId: "__system__", source: "provider_keys", severity: "info",
        message: `removed the Claude and ChatGPT sign-ins of ${removed} deleted account${removed === 1 ? "" : "s"} from the subscription runner`,
      });
    }
    return removed;
  }

  private async signOutDeleted(userId: string, provider: SubscriptionProvider): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.runner.logout(userId, provider);
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < 3) { await this.sleep(attempt * 2000); continue; }
        logger.warn({ userId, provider, reason }, "subscription sign-out of a deleted account failed");
        recordSystemEvent({
          userId: "__system__", source: "provider_keys", severity: "error",
          message: `the ${provider === "claude" ? "Claude" : "ChatGPT"} sign-in of a deleted account could not be removed from the subscription runner (${reason.slice(0, 160)}); the API retries at its next start`,
          details: { deletedUserId: userId, provider },
        });
      }
    }
    return false;
  }

  private recordAccount(userId: string, provider: SubscriptionProvider, reported: RunnerAccountStatus, freshConnection: boolean): SubscriptionStatus {
    const now = this.now();
    const existing = this.connections.find(userId, provider);
    this.connections.upsert(userId, provider, {
      status: "connected",
      accountEmail: reported.email ?? null,
      accountOrg: reported.org ?? null,
      plan: reported.plan ?? null,
      connectedAt: freshConnection || !existing?.connectedAt ? now : existing.connectedAt,
      verifiedAt: now,
      lastError: null,
    }, now);
    return this.status(userId, provider);
  }

  private currentStatus(userId: string, provider: SubscriptionProvider): SubscriptionStatus["status"] {
    const row = this.connections.find(userId, provider);
    return row?.status === "connected" || row?.status === "expired" ? row.status : "disconnected";
  }

  private pendingKey(userId: string, provider: SubscriptionProvider) { return `${userId}:${provider}`; }

  /** True once a logout of this connection has finished after this call (the logout wins). */
  private loggedOutSince(userId: string, provider: SubscriptionProvider): () => boolean {
    const key = this.pendingKey(userId, provider);
    const seen = this.logouts.get(key) ?? 0;
    return () => (this.logouts.get(key) ?? 0) !== seen;
  }

  /** A sign-in of this connection started or was cancelled. */
  private bumpAttempt(userId: string, provider: SubscriptionProvider) {
    const key = this.pendingKey(userId, provider);
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
  }

  /** True once a logout finished or a sign-in started or was cancelled after this call: it then writes nothing. */
  private staleSince(userId: string, provider: SubscriptionProvider): () => boolean {
    const loggedOut = this.loggedOutSince(userId, provider);
    const key = this.pendingKey(userId, provider);
    const seen = this.attempts.get(key) ?? 0;
    return () => loggedOut() || (this.attempts.get(key) ?? 0) !== seen;
  }

  private assertAvailable() {
    if (!this.available) throw new HttpError(503, "Subscription sign-in is not available on this server");
  }

  private assertUser(userId: string) {
    if (!this.users.findById(userId)) throw new HttpError(401, "user not found");
  }
}
