import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ProviderId } from "@tracyhill-rp/contracts";

import { ApiError } from "../../shared/api/client";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";
import { completeSignIn, createUserScopedCacheWriter } from "./authCache";
import { getProviderKeys, updateProviderKeys } from "./providerKeyApi";
import { API_KEY_PROVIDERS } from "./providerList";
import { AUTH_OPTIONS_QUERY_KEY, createFirstAdmin, describeConnectedProviders, isUnencryptedRemote, verifySetupCode } from "./setupApi";
import { SubscriptionCards } from "./SubscriptionCards";

// First-run setup: the one-time code from the server log, the first
// administrator, then at least one model provider. App renders it at /setup while the deployment has no account, and
// again for the signed-in administrator, whose step is chosen from the session rather than kept in component state.

type SetupPageProps = {
  signedIn: boolean;
};

export function SetupPage({ signedIn }: SetupPageProps) {
  // The address stays /setup through the account step, so App keeps this page up once the new account is signed in.
  useEffect(() => {
    if (window.location.pathname !== "/setup") window.history.replaceState(null, "", "/setup");
  }, []);
  return <FullscreenCenter>{signedIn ? <ProviderStep /> : <AccountSteps />}</FullscreenCenter>;
}

function Logo() {
  return <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="auth-logo" />;
}

function PlainHttpWarning() {
  if (!isUnencryptedRemote(window.location)) return null;
  return (
    <p className="setup-warning" role="alert">
      This page is not using HTTPS, so the setup code, your password and any API keys cross the network unencrypted. Put the server behind HTTPS first, unless this is a private network you trust.
    </p>
  );
}

function AccountSteps() {
  const queryClient = useQueryClient();
  const [setupCode, setSetupCode] = useState("");
  const [codeAccepted, setCodeAccepted] = useState(false);
  // A message carried back to the code step (a restart printed a new code).
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const verify = useMutation({
    mutationFn: verifySetupCode,
    onSuccess: () => { setNotice(""); setCodeAccepted(true); },
  });
  const create = useMutation({
    mutationFn: createFirstAdmin,
    onSuccess: (response) => {
      setPassword("");
      setConfirmPassword("");
      completeSignIn(queryClient, response.user);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        // The server restarted and printed a new code.
        setNotice(error.message);
        setCodeAccepted(false);
        verify.reset();
      } else if (error instanceof ApiError && error.status === 409) {
        // Someone finished setup first: App shows the sign-in page.
        void queryClient.invalidateQueries({ queryKey: AUTH_OPTIONS_QUERY_KEY });
      }
    },
  });

  if (!codeAccepted) {
    const error = verify.error?.message ?? notice;
    return (
      <section className="auth-card setup-card">
        <Logo />
        <p className="setup-step">Step 1 of 3</p>
        <h1 className="setup-title">Set up TracyHill RP</h1>
        <p className="auth-sub">This server has no accounts yet. To show that you are the person running it, enter the setup code from the server's log. On the server, run:</p>
        <pre className="setup-command">docker compose logs tracyhill-rp | grep -A 2 "setup code"</pre>
        <p className="setup-hint">A new code is printed each time the server restarts.</p>
        <PlainHttpWarning />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            verify.mutate({ setupCode });
          }}
        >
          <label className="setup-label" htmlFor="setup-code">Setup code</label>
          <input
            id="setup-code"
            className="auth-input"
            type="text"
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
          />
          {error ? <p className="auth-error">{error}</p> : null}
          <button type="submit" className="auth-submit" disabled={verify.isPending || !setupCode.trim()}>
            {verify.isPending ? "Checking..." : "Continue"}
          </button>
        </form>
      </section>
    );
  }

  const error = mismatch ? "The two passwords are not the same." : create.error?.message;
  return (
    <section className="auth-card setup-card">
      <Logo />
      <p className="setup-step">Step 2 of 3</p>
      <h1 className="setup-title">Create the administrator account</h1>
      <p className="auth-sub">The administrator creates accounts for other people, resets their passwords and sees the server's health. The password needs at least 8 characters, with an upper-case letter, a lower-case letter and a number.</p>
      <PlainHttpWarning />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== confirmPassword) { setMismatch(true); return; }
          setMismatch(false);
          // The browser's zone sets the server's daily sign-out (3 AM there).
          const timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } })();
          create.mutate({ setupCode, username, password, ...(timeZone ? { timeZone } : {}) });
        }}
      >
        <input
          className="auth-input"
          type="text"
          placeholder="Username"
          aria-label="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          className="auth-input"
          type="password"
          placeholder="Password"
          aria-label="Password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setMismatch(false); }}
        />
        <input
          className="auth-input"
          type="password"
          placeholder="Confirm password"
          aria-label="Confirm password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => { setConfirmPassword(event.target.value); setMismatch(false); }}
        />
        {error ? <p className="auth-error">{error}</p> : null}
        <button type="submit" className="auth-submit" disabled={create.isPending || !username.trim() || !password || !confirmPassword}>
          {create.isPending ? "Creating..." : "Create account"}
        </button>
      </form>
      <div className="auth-link-row">
        <button
          type="button"
          className="auth-link setup-text-button"
          onClick={() => { setCodeAccepted(false); verify.reset(); create.reset(); }}
        >
          Use a different setup code
        </button>
      </div>
    </section>
  );
}

function ProviderStep() {
  const queryClient = useQueryClient();
  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const keys = useQuery({ queryKey: ["provider-keys"], queryFn: getProviderKeys });
  const [provider, setProvider] = useState<ProviderId>(API_KEY_PROVIDERS[0]!.id);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState("");
  const selected = API_KEY_PROVIDERS.find((entry) => entry.id === provider) ?? API_KEY_PROVIDERS[0]!;
  const save = useMutation({
    mutationFn: updateProviderKeys,
    onSuccess: (data) => {
      cacheUserQuery(["provider-keys"], data);
      setApiKey("");
      setSaved(`Saved the ${selected.label} key.`);
    },
  });
  const connected = describeConnectedProviders(keys.data, API_KEY_PROVIDERS);
  // A full load into the app: the first account starts with a clean shell.
  const finish = () => window.location.assign("/");

  return (
    <section className="auth-card setup-card setup-card-wide">
      <Logo />
      <p className="setup-step">Step 3 of 3</p>
      <h1 className="setup-title">Connect a model provider</h1>
      <p className="auth-sub">TracyHill RP writes with the AI models you connect. Connect at least one: paste an API key from a provider, or sign in with your own Claude or ChatGPT subscription.</p>
      <PlainHttpWarning />
      <p className="setup-connected">
        {keys.isLoading ? "Checking what is connected..." : connected.length ? `Connected: ${connected.join(", ")}` : "Nothing is connected yet."}
      </p>
      <form
        className="setup-section"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved("");
          save.mutate({ [provider]: apiKey.trim() });
        }}
      >
        <h2 className="setup-section-title">API key</h2>
        <label className="setup-label" htmlFor="setup-provider">Provider</label>
        <select
          id="setup-provider"
          className="auth-input"
          value={provider}
          onChange={(event) => { setProvider(event.target.value as ProviderId); setSaved(""); save.reset(); }}
        >
          {API_KEY_PROVIDERS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
        <p className="setup-hint">{selected.detail}</p>
        <input
          className="auth-input"
          type="password"
          placeholder={`${selected.label} API key`}
          aria-label={`${selected.label} API key`}
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {save.error ? <p className="auth-error">{save.error.message}</p> : saved ? <p className="setup-ok">{saved}</p> : null}
        <button type="submit" className="auth-submit" disabled={save.isPending || !apiKey.trim()}>
          {save.isPending ? "Saving..." : "Save key"}
        </button>
      </form>
      <div className="setup-section">
        <SubscriptionCards open seed={keys.data?.subscriptions ?? null} />
      </div>
      <button type="button" className="auth-submit" disabled={!connected.length} onClick={finish}>Finish setup</button>
      <div className="auth-link-row">
        <button type="button" className="auth-link setup-text-button" onClick={finish}>Skip for now</button>
      </div>
      <p className="setup-hint setup-footnote">You can add or change providers at any time, including your own OpenAI-compatible endpoint, from Options → Providers. Sign-up, email and the daily sign-out time are in Admin: Server settings.</p>
    </section>
  );
}
