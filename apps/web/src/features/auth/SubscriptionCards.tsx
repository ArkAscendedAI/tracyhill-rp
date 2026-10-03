import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
  SubscriptionLoginCancelRequest,
  SubscriptionLoginCompleteRequest,
  SubscriptionLoginStartResponse,
  SubscriptionProvider,
  SubscriptionStatus,
  SubscriptionsResponse,
} from "@tracyhill-rp/contracts";

import { ApiError } from "../../shared/api/client";
import { createUserScopedCacheWriter } from "./authCache";
import {
  cancelSubscriptionLogin,
  completeSubscriptionLogin,
  getSubscriptionStatus,
  getSubscriptions,
  logoutSubscription,
  startSubscriptionLogin,
} from "./subscriptionApi";
import { describeConnectedSubscription, describeSubscriptionState, pastedCodeProblem } from "./subscriptionDisplay";
import { startDeviceSignInPoll } from "./subscriptionPoll";

// The Subscriptions area of the Providers dialog. One card per provider, each driving its own sign-in: Claude
// hands the user a code to paste back ("paste-code"); ChatGPT's device flow
// completes on the provider's page while the card polls ("poll"). The
// provider-keys response seeds the first paint; GET /api/providers/subscriptions
// is the source of truth while the dialog is open.

export const SUBSCRIPTIONS_QUERY_KEY = ["subscriptions"] as const;

/**
 * The calls a set of cards drives: the account's own sign-ins here, or the server-wide ones that Admin: Server settings
 * → Shared keys passes in. Status reads ask the runner (`verify`), as the dialog always has.
 */
export type SubscriptionCalls = {
  queryKey: readonly unknown[];
  list: () => Promise<SubscriptionsResponse>;
  start: (provider: SubscriptionProvider) => Promise<SubscriptionLoginStartResponse>;
  complete: (provider: SubscriptionProvider, payload: SubscriptionLoginCompleteRequest) => Promise<SubscriptionStatus>;
  cancel: (provider: SubscriptionProvider, payload: SubscriptionLoginCancelRequest) => Promise<SubscriptionStatus>;
  logout: (provider: SubscriptionProvider) => Promise<SubscriptionStatus>;
  status: (provider: SubscriptionProvider) => Promise<SubscriptionStatus>;
};

const ACCOUNT_CALLS: SubscriptionCalls = {
  queryKey: SUBSCRIPTIONS_QUERY_KEY,
  list: () => getSubscriptions({ verify: true }),
  start: (provider) => startSubscriptionLogin(provider),
  complete: (provider, payload) => completeSubscriptionLogin(provider, payload),
  cancel: (provider, payload) => cancelSubscriptionLogin(provider, payload),
  logout: (provider) => logoutSubscription(provider),
  status: (provider) => getSubscriptionStatus(provider, { verify: true }),
};

/**
 * A card's Connect: starts the provider's sign-in. A refusal's sentence goes to the card. The 409 "Already connected.
 * Log out first." means the card is stale: another tab or device finished a sign-in. The list is read again, so
 * the card turns into the connected one and keeps the sentence.
 */
export function startLoginMutationOptions(
  queryClient: QueryClient,
  provider: SubscriptionProvider,
  card: { onStarted: (started: SubscriptionLoginStartResponse) => void; onFailed: (message: string) => void },
  calls: SubscriptionCalls = ACCOUNT_CALLS,
) {
  return {
    mutationFn: () => calls.start(provider),
    onSuccess: card.onStarted,
    onError: (error: Error) => {
      card.onFailed(error.message);
      if (error instanceof ApiError && error.status === 409) void queryClient.invalidateQueries({ queryKey: calls.queryKey });
    },
  };
}

/** The server-wide cards (Admin: Server settings → Shared keys): their calls, words, and the warning to accept first. */
export type SharedSubscriptionScope = {
  calls: SubscriptionCalls;
  // Connect stays off, with this sentence, until the owner accepts the ban warning above the cards.
  connectBlocked: string | null;
};

type SubscriptionCardsProps = {
  open: boolean;
  seed: SubscriptionsResponse | null | undefined;
  // The account's cards: the providers whose server-wide sign-in serves this account while it has none of its own.
  sharedServes?: Partial<Record<SubscriptionProvider, boolean>>;
  // Set for the server-wide cards.
  shared?: SharedSubscriptionScope;
};

type CardCopy = {
  provider: SubscriptionProvider;
  // The word used in the button names ("Connect Claude subscription").
  name: string;
  title: string;
  subtitle: string;
  sharedSubtitle: string;
  linkText: string;
  codeInputLabel: string;
};

const CARDS: CardCopy[] = [
  {
    provider: "claude",
    name: "Claude",
    title: "Claude subscription",
    subtitle: "Signs in to Claude Code with your Claude account.",
    sharedSubtitle: "Claude Code for every account that has no Claude sign-in of its own.",
    linkText: "Open Anthropic sign-in",
    codeInputLabel: "Claude sign-in code",
  },
  {
    provider: "chatgpt",
    name: "ChatGPT",
    title: "ChatGPT subscription",
    subtitle: "Signs in to Codex with your ChatGPT account.",
    sharedSubtitle: "Codex for every account that has no ChatGPT sign-in of its own.",
    linkText: "Open ChatGPT device sign-in",
    codeInputLabel: "ChatGPT sign-in code",
  },
];

export function SubscriptionCards({ open, seed, sharedServes, shared }: SubscriptionCardsProps) {
  const queryClient = useQueryClient();
  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const calls = shared?.calls ?? ACCOUNT_CALLS;
  const query = useQuery({
    queryKey: calls.queryKey,
    queryFn: calls.list,
    enabled: open,
    retry: 1,
  });
  const statuses = query.data ?? seed ?? null;

  // A status returned by a write (complete, cancel, logout) or seen by the poll
  // lands in the cache at once and the list is refreshed from the server. A
  // change of connection also refreshes the provider-keys bootstrap, which every
  // model picker gates the bridge models on.
  const applyStatus = (next: SubscriptionStatus, connectionChanged: boolean) => {
    const base = queryClient.getQueryData<SubscriptionsResponse>(calls.queryKey) ?? statuses;
    if (base) cacheUserQuery(calls.queryKey, { ...base, [next.provider]: next });
    void queryClient.invalidateQueries({ queryKey: calls.queryKey });
    if (connectionChanged) void queryClient.invalidateQueries({ queryKey: ["provider-keys"] });
  };

  return (
    <div className="stack stack-tight">
      <div className="section-head">
        <div>
          <p className="eyebrow">Subscriptions</p>
          <h3>{shared ? "Shared Claude and ChatGPT sign-ins" : "Claude and ChatGPT subscriptions"}</h3>
        </div>
      </div>
      <p className="muted small-copy">
        {shared
          ? "Sign in with your own Claude or ChatGPT account. Every account on this server without a sign-in of its own then runs its subscription turns on yours, against your plan's limits. The app stores no token, and you can log out at any time."
          : "Sign in to your own subscription. Turns then run through the official Claude Code or Codex program on this server under your own account. The app stores no token, and you can log out at any time."}
      </p>
      {query.isLoading && !statuses ? <p className="muted small-copy">Loading subscription status…</p> : null}
      {query.isError ? <p className="muted small-copy">Subscription status could not be loaded.</p> : null}
      {statuses ? CARDS.map((copy) => (
        <SubscriptionCard
          key={copy.provider}
          copy={copy}
          status={statuses[copy.provider]}
          onStatus={applyStatus}
          calls={calls}
          shared={shared ?? null}
          servedByServer={!shared && sharedServes?.[copy.provider] === true}
        />
      )) : null}
    </div>
  );
}

type SubscriptionCardProps = {
  copy: CardCopy;
  status: SubscriptionStatus;
  onStatus: (next: SubscriptionStatus, connectionChanged: boolean) => void;
  calls: SubscriptionCalls;
  shared: SharedSubscriptionScope | null;
  // The account has no sign-in of its own and the server-wide one serves it.
  servedByServer: boolean;
};

function SubscriptionCard({ copy, status, onStatus, calls, shared, servedByServer }: SubscriptionCardProps) {
  const { provider } = copy;
  // The start response of the sign-in in progress, if any.
  const [login, setLogin] = useState<SubscriptionLoginStartResponse | null>(null);
  const [code, setCode] = useState("");
  // The device code's own expiry passed before the sign-in finished.
  const [codeExpired, setCodeExpired] = useState(false);
  // The message from the last start/complete/cancel/logout/poll call that failed.
  const [actionError, setActionError] = useState<string | null>(null);
  // Live copies for the poll and the unmount cancel, which must not restart on a render.
  const loginRef = useRef(login);
  loginRef.current = login;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const statusRef = useRef(status);
  statusRef.current = status;
  const callsRef = useRef(calls);
  callsRef.current = calls;

  const queryClient = useQueryClient();
  const startMutation = useMutation(startLoginMutationOptions(queryClient, provider, {
    onStarted: (started) => {
      setLogin(started);
      setCode("");
      setCodeExpired(false);
      setActionError(null);
    },
    onFailed: setActionError,
  }, calls));
  const completeMutation = useMutation({
    mutationFn: (payload: { loginId: string; code: string }) => calls.complete(provider, payload),
    onSuccess: (next) => {
      setLogin(null);
      setCode("");
      setActionError(null);
      onStatus(next, true);
    },
    onError: (error) => setActionError(error.message),
  });
  const cancelMutation = useMutation({
    mutationFn: (loginId: string) => calls.cancel(provider, { loginId }),
    // The abandoned sign-in's errors (a failed poll read, a rejected code) go with it.
    onSuccess: (next) => {
      setActionError(null);
      onStatus(next, false);
    },
    onError: (error) => setActionError(error.message),
    onSettled: () => {
      setLogin(null);
      setCode("");
    },
  });
  const logoutMutation = useMutation({
    mutationFn: () => calls.logout(provider),
    onSuccess: (next) => {
      setActionError(null);
      onStatus(next, true);
    },
    onError: (error) => setActionError(error.message),
  });

  // Device-code flow: ask for the status every three seconds while the sign-in
  // is pending (subscriptionPoll.ts owns the stop rule). Stops at the sign-in's
  // outcome, when the code's own expiry passes, or when the card unmounts.
  useEffect(() => {
    if (!login || login.completion !== "poll") return;
    const pending = login;
    return startDeviceSignInPoll({
      expiresAt: pending.expiresAt,
      baseline: { status: statusRef.current.status },
      readStatus: () => callsRef.current.status(provider),
      onOutcome: (next) => {
        setLogin(null);
        onStatusRef.current(next, true);
      },
      onCodeExpired: () => {
        setLogin(null);
        setCodeExpired(true);
        void callsRef.current.cancel(provider, { loginId: pending.loginId }).catch(() => undefined);
      },
      onReadError: setActionError,
    });
  }, [login, provider]);

  // Closing the dialog with a sign-in pending cancels it, best effort.
  useEffect(() => () => {
    const pending = loginRef.current;
    if (pending) void callsRef.current.cancel(provider, { loginId: pending.loginId }).catch(() => undefined);
  }, [provider]);

  const busy = startMutation.isPending || completeMutation.isPending || cancelMutation.isPending || logoutMutation.isPending;
  const finishCode = code.trim();
  // Text longer than a sign-in code is named here instead of the route's bare 400.
  const codeProblem = pastedCodeProblem(code);
  const finish = () => {
    if (!login || !finishCode || busy || codeProblem) return;
    completeMutation.mutate({ loginId: login.loginId, code: finishCode });
  };

  return (
    <div className="placeholder-card stack stack-tight subscription-card">
      <div className="section-head">
        <strong>{copy.title}</strong>
        <span className="muted small-copy">{describeSubscriptionState(status)}</span>
      </div>
      <p className="muted small-copy">{shared ? copy.sharedSubtitle : copy.subtitle}</p>
      {servedByServer && status.status !== "connected" ? (
        <p className="small-copy">This server shares a {copy.name} sign-in, and your turns run on it. Connect your own to use your plan instead.</p>
      ) : null}
      {!status.available ? (
        <p className="muted small-copy">Not available on this server.</p>
      ) : login ? (
        <>
          <ol className="subscription-steps">
            <li>
              Open the sign-in link: <a href={login.url} target="_blank" rel="noopener noreferrer">{copy.linkText}</a>
            </li>
            {login.completion === "paste-code" ? (
              <li>
                Paste the code the page shows
                <div className="row gap-sm wrap-row">
                  <input
                    aria-label={copy.codeInputLabel}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Code from the sign-in page"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      finish();
                    }}
                    disabled={busy}
                  />
                </div>
                {codeProblem ? <p className="error small-copy" role="alert">{codeProblem}</p> : null}
              </li>
            ) : (
              <li>
                {login.userCode ? <>Enter this code on that page: <code className="subscription-code">{login.userCode}</code></> : "Finish the sign-in on that page."}
              </li>
            )}
          </ol>
          {login.completion === "poll" ? <p className="muted small-copy">Waiting for the sign-in to finish.</p> : null}
          {actionError ? <p className="error">{actionError}</p> : null}
          <div className="row gap-sm wrap-row">
            {login.completion === "paste-code" ? (
              <button type="button" disabled={busy || !finishCode || codeProblem != null} onClick={finish}>
                {completeMutation.isPending ? "Finishing..." : "Finish sign-in"}
              </button>
            ) : null}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => cancelMutation.mutate(login.loginId)}>
              {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
            </button>
          </div>
        </>
      ) : status.status === "connected" ? (
        <>
          <p className="small-copy">{describeConnectedSubscription(status)}</p>
          {status.verifiedAt ? <p className="muted small-copy">Verified {new Date(status.verifiedAt).toLocaleString()}</p> : null}
          {actionError ?? status.lastError ? <p className="error">{actionError ?? status.lastError}</p> : null}
          <div className="row gap-sm wrap-row">
            <button type="button" className="secondary-button" aria-label={`Log out of ${copy.name} subscription`} disabled={busy} onClick={() => logoutMutation.mutate()}>
              {logoutMutation.isPending ? "Logging out..." : "Log out"}
            </button>
          </div>
        </>
      ) : (
        <>
          {status.status === "expired" ? <p className="small-copy">Your sign-in expired. Sign in again.</p> : null}
          {codeExpired ? <p className="small-copy">The code expired. Start again.</p> : null}
          {actionError ?? status.lastError ? <p className="error">{actionError ?? status.lastError}</p> : null}
          {shared?.connectBlocked ? <p className="muted small-copy">{shared.connectBlocked}</p> : null}
          <div className="row gap-sm wrap-row">
            <button
              type="button"
              aria-label={`Connect ${copy.name} subscription`}
              disabled={busy || Boolean(shared?.connectBlocked)}
              onClick={() => {
                setActionError(null);
                setCodeExpired(false);
                startMutation.mutate();
              }}
            >
              {startMutation.isPending ? "Starting..." : "Connect"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
