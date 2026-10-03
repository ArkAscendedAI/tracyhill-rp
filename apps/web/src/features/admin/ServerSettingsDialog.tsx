import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { EmailProvider, RegistrationMode, ServerSettings, SmtpSecurity, UpdateServerSettingsRequest } from "@tracyhill-rp/contracts";

import { Dialog } from "../../shared/ui/Dialog";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/iconSprite";
import { API_KEY_PROVIDERS } from "../auth/providerList";
import { SubscriptionCards } from "../auth/SubscriptionCards";
import { browserTimeZone, changedFields, formatHour, getServerSettings, knownTimeZones, sendTestEmail, SERVER_SETTINGS_QUERY_KEY, SERVER_SUBSCRIPTION_CALLS, updateServerSettings } from "./serverSettingsApi";

// Admin: Server settings. The Engine dialog's layout: a page list on the left,
// one row per setting with its explanation visible, one fixed height. Each page saves its own changes; a value the
// server's .env sets shows locked.

type PageId = "accounts" | "twoFactor" | "email" | "sharedKeys" | "sessions" | "newSessions" | "server";
const PAGES: Array<{ id: PageId; label: string; icon: IconName }> = [
  { id: "accounts", label: "Accounts", icon: "users" },
  { id: "twoFactor", label: "Two-factor", icon: "shield" },
  { id: "email", label: "Email", icon: "send" },
  { id: "sharedKeys", label: "Shared keys", icon: "key" },
  { id: "sessions", label: "Sessions", icon: "clock" },
  { id: "newSessions", label: "New sessions", icon: "sliders" },
  { id: "server", label: "Server", icon: "wrench" },
];

// The Engine panel's names for the two content dials (EngineSettingsDialog.tsx), so both places read the same.
const STANCE_OPTIONS: Array<[number, string]> = [[0, "0 · Indulgent"], [1, "1 · Earned"], [2, "2 · Indifferent"], [3, "3 · Hostile"], [4, "4 · Predatory"]];
const TIER_OPTIONS: Array<[number, string]> = [[0, "0 · None"], [1, "1 · Direct"], [2, "2 · Visceral"], [3, "3 · Unflinching"]];

type Save = (patch: UpdateServerSettingsRequest) => void;

type ServerSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function ServerSettingsDialog({ open, onClose }: ServerSettingsDialogProps) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<PageId>("accounts");
  // Bumped after every save so a page's draft restarts from what the server stored.
  const [revision, setRevision] = useState(0);
  const query = useQuery({ queryKey: SERVER_SETTINGS_QUERY_KEY, queryFn: getServerSettings, enabled: open });
  const mutation = useMutation({
    mutationFn: updateServerSettings,
    onSuccess: (settings) => {
      queryClient.setQueryData(SERVER_SETTINGS_QUERY_KEY, settings);
      void queryClient.invalidateQueries({ queryKey: ["auth-options"] });
      setRevision((value) => value + 1);
    },
  });
  const save: Save = (patch) => mutation.mutate(patch);
  const settings = query.data;
  const saveState = { saving: mutation.isPending, error: mutation.error?.message ?? null, saved: mutation.isSuccess && !mutation.isPending };

  return (
    <Dialog open={open} onClose={onClose} label="Server settings" eyebrow="Admin" title="Server settings" icon="wrench" size="wide" className="engine-dialog" bodyClassName="dialog-body-flush">
      <div className="eng-layout">
        <nav className="eng-nav" aria-label="Server settings pages">
          <div className="eng-nav-pages">
            {PAGES.map((p) => (
              <button key={p.id} type="button" className={`eng-nav-btn${page === p.id ? " is-active" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => { setPage(p.id); mutation.reset(); }}>
                <Icon name={p.icon} size={15} /> {p.label}
              </button>
            ))}
          </div>
          <p className="eng-nav-note">These apply to everyone on this server. A value set in the server's .env file wins and shows locked.</p>
        </nav>
        <div className="eng-page">
          {query.isLoading ? <p className="eng-blurb">Loading the server's settings…</p> : null}
          {query.isError ? <p className="eng-blurb settings-error">The settings could not be loaded: {query.error.message}</p> : null}
          {settings && page === "accounts" ? <AccountsPage key={`a${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "twoFactor" ? <TwoFactorPage key={`t${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "email" ? <EmailPage key={`e${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "sharedKeys" ? <SharedKeysPage key={`k${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "sessions" ? <SessionsPage key={`s${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "newSessions" ? <NewSessionsPage key={`n${revision}`} settings={settings} save={save} state={saveState} /> : null}
          {settings && page === "server" ? <ServerPage settings={settings} /> : null}
        </div>
      </div>
    </Dialog>
  );
}

// The pages are exported for their render tests.
export type PageProps = { settings: ServerSettings; save: Save; state: { saving: boolean; error: string | null; saved: boolean } };

function Row({ label, hint, locked, children }: { label: string; hint?: ReactNode; locked?: boolean; children: ReactNode }) {
  return (
    <div className="eng-row">
      <div className="eng-row-text">
        <span className="eng-label">{label}</span>
        {hint ? <span className="eng-hint">{hint}</span> : null}
        {locked ? <span className="eng-hint eng-locked"><Icon name="shield" size={11} /> Set in the server's configuration (.env).</span> : null}
      </div>
      <div className="eng-ctl">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`eng-switch${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)} disabled={disabled}>
      <span className="eng-switch-knob" aria-hidden="true" />
      <span className="eng-switch-text" aria-hidden="true">{checked ? "On" : "Off"}</span>
    </button>
  );
}

function SaveBar({ dirty, state, onSave }: { dirty: boolean; state: PageProps["state"]; onSave: () => void }) {
  return (
    <div className="settings-savebar">
      {state.error ? <span className="settings-error">{state.error}</span> : state.saved && !dirty ? <span className="settings-ok">Saved.</span> : null}
      <button type="button" className="primary-button" disabled={!dirty || state.saving} onClick={onSave}>{state.saving ? "Saving…" : "Save changes"}</button>
    </div>
  );
}

export function AccountsPage({ settings, save, state }: PageProps) {
  const [draft, setDraft] = useState(settings.accounts);
  const changes = changedFields(settings.accounts, draft);
  const dirty = Object.keys(changes).length > 0;
  const emailWorks = settings.email.working;
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">Who can get an account, and what people agree to when they sign up.</p>
      <div className="eng-group">
        <h3 className="eng-group-title">Sign-up</h3>
        <Row
          label="Let people create their own accounts"
          hint={draft.registration === "open"
            ? (emailWorks ? "Anyone who can reach this server can sign up; the email address is confirmed with a code." : "Open, but sign-up stays unavailable until email works (Email page): it confirms each address with a code.")
            : "Only the administrator creates accounts (Admin: Users). The sign-in page shows no sign-up link."}
        >
          <select aria-label="Sign-up" value={draft.registration} onChange={(event) => setDraft({ ...draft, registration: event.target.value as RegistrationMode })}>
            <option value="off">Off</option>
            <option value="open">Open</option>
          </select>
        </Row>
        <Row label="Ask people to accept the terms" hint="Sign-up shows a box people must tick to accept the terms below.">
          <Toggle label="Ask people to accept the terms" checked={draft.termsRequired} onChange={(termsRequired) => setDraft({ ...draft, termsRequired })} />
        </Row>
      </div>
      <div className="eng-group">
        <h3 className="eng-group-title">Terms and privacy</h3>
        <p className="eng-hint settings-textarea-hint">Shown at /terms and /privacy. Leave a box blank to use the built-in text.</p>
        <label className="settings-textarea">
          <span className="eng-label">Terms</span>
          <textarea aria-label="Terms text" rows={6} maxLength={20_000} value={draft.termsText} placeholder="The built-in terms" onChange={(event) => setDraft({ ...draft, termsText: event.target.value })} />
        </label>
        <label className="settings-textarea">
          <span className="eng-label">Privacy</span>
          <textarea aria-label="Privacy text" rows={6} maxLength={20_000} value={draft.privacyText} placeholder="The built-in privacy notice" onChange={(event) => setDraft({ ...draft, privacyText: event.target.value })} />
        </label>
      </div>
      <SaveBar dirty={dirty} state={state} onSave={() => save({ accounts: changes })} />
    </div>
  );
}

const RECOVERY_COMMAND = "docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name> --reset-two-factor";

export function TwoFactorPage({ settings, save, state }: PageProps) {
  const [draft, setDraft] = useState(settings.twoFactor);
  const changes = changedFields(settings.twoFactor, draft);
  const dirty = Object.keys(changes).length > 0;
  const emailWorks = settings.email.working;
  const problem = draft.policy === "required" && !draft.totp
    ? "Required needs the authenticator app: it is how someone without a second step sets one up at sign-in."
    : draft.policy !== "off" && !draft.totp && !draft.email
      ? "Choose at least one method, or set two-step sign-in to Off."
      : null;
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">A second step at sign-in, after the password: a code from an authenticator app on the person's phone, or a code sent by email.</p>
      <div className="eng-group">
        <h3 className="eng-group-title">Policy</h3>
        <Row
          label="Two-step sign-in"
          hint={draft.policy === "off"
            ? "Nobody is asked for a second step, even where one is set up."
            : draft.policy === "optional"
              ? "People who set up a second step (Options → MFA settings) are asked for it; the others sign in with their password."
              : "Everyone is asked for a second step. Anyone without one sets up an authenticator app at their next sign-in, you included."}
        >
          <select aria-label="Two-step sign-in policy" value={draft.policy} onChange={(event) => setDraft({ ...draft, policy: event.target.value as typeof draft.policy })}>
            <option value="off">Off</option>
            <option value="optional">Optional</option>
            <option value="required">Required</option>
          </select>
        </Row>
      </div>
      <div className="eng-group">
        <h3 className="eng-group-title">Methods</h3>
        <Row label="Authenticator app" hint="Google Authenticator, Microsoft Authenticator, 1Password, Authy or any other. Works without email; each setup comes with ten one-time recovery codes.">
          <Toggle label="Authenticator app" checked={draft.totp} onChange={(totp) => setDraft({ ...draft, totp })} />
        </Row>
        <Row label="Email codes" hint={emailWorks ? "A code sent to the person's verified email address." : "Needs working email (Email page) and a verified address; until then nobody is asked for one."}>
          <Toggle label="Email codes" checked={draft.email} onChange={(email) => setDraft({ ...draft, email })} />
        </Row>
      </div>
      <div className="eng-group">
        <h3 className="eng-group-title">Lost phone</h3>
        <p className="eng-hint">An administrator resets someone's two-step sign-in in Admin: Users (Reset 2FA). For your own account, or when nobody can sign in, run this on the server; --new-password and --two-factor-off are there too:</p>
        <pre className="settings-command">{RECOVERY_COMMAND}</pre>
      </div>
      {problem ? <p className="eng-hint settings-error">{problem}</p> : null}
      <SaveBar dirty={dirty && !problem} state={state} onSave={() => save({ twoFactor: changes })} />
    </div>
  );
}

type SecretDraft = { value: string; remove: boolean };
const KEEP: SecretDraft = { value: "", remove: false };

function SecretInput({ label, summary, draft, onChange, locked }: { label: string; summary: { configured: boolean; last4: string | null }; draft: SecretDraft; onChange: (next: SecretDraft) => void; locked: boolean }) {
  const stored = summary.configured && !draft.remove;
  return (
    <div className="settings-secret">
      {stored ? <span className="settings-secret-state">Set{summary.last4 ? ` (ends in ${summary.last4})` : ""}</span> : draft.remove ? <span className="settings-secret-state">Will be removed</span> : null}
      <input type="password" aria-label={label} autoComplete="off" spellCheck={false} disabled={locked} placeholder={stored ? "Replace…" : "Paste it here"} value={draft.value} onChange={(event) => onChange({ value: event.target.value, remove: false })} />
      {summary.configured && !locked ? (
        <button type="button" className="secondary-button" onClick={() => onChange(draft.remove ? KEEP : { value: "", remove: true })}>{draft.remove ? "Keep" : "Remove"}</button>
      ) : null}
    </div>
  );
}

function emailStatus(settings: ServerSettings): { tone: "ok" | "warn" | "off"; text: string } {
  const email = settings.email;
  if (email.source === "environment") return { tone: "ok", text: `Working: SendGrid, set in the server's configuration (.env), sending from ${email.fromAddress}.` };
  if (email.source === "none") return { tone: "off", text: "Off. Sign-up, forgot password and email codes stay unavailable until email works." };
  if (email.working) return { tone: "ok", text: `Working. The last test reached ${email.lastTest?.to ?? "its address"}.` };
  if (email.lastTest && !email.lastTest.ok) return { tone: "warn", text: `The last test failed: ${email.lastTest.error ?? "unknown error"}` };
  return { tone: "warn", text: "Not proven yet. Save, then send a test email; email counts as working once a test gets through." };
}

export function EmailPage({ settings, save, state }: PageProps) {
  const queryClient = useQueryClient();
  const saved = settings.email;
  const isLocked = (field: string) => settings.locked.includes(`email.${field}`);
  const [draft, setDraft] = useState({ provider: saved.provider, fromAddress: saved.fromAddress, fromName: saved.fromName, smtpHost: saved.smtpHost, smtpPort: saved.smtpPort, smtpSecurity: saved.smtpSecurity, smtpUsername: saved.smtpUsername });
  const [sendgridKey, setSendgridKey] = useState<SecretDraft>(KEEP);
  const [smtpPassword, setSmtpPassword] = useState<SecretDraft>(KEEP);
  const [testTo, setTestTo] = useState("");
  const test = useMutation({
    mutationFn: sendTestEmail,
    onSuccess: (result) => {
      queryClient.setQueryData(SERVER_SETTINGS_QUERY_KEY, result.settings);
      void queryClient.invalidateQueries({ queryKey: ["auth-options"] });
    },
  });
  const plain = changedFields({ provider: saved.provider, fromAddress: saved.fromAddress, fromName: saved.fromName, smtpHost: saved.smtpHost, smtpPort: saved.smtpPort, smtpSecurity: saved.smtpSecurity, smtpUsername: saved.smtpUsername }, draft);
  const patch: NonNullable<UpdateServerSettingsRequest["email"]> = { ...plain };
  if (sendgridKey.remove) patch.sendgridApiKey = null;
  else if (sendgridKey.value.trim()) patch.sendgridApiKey = sendgridKey.value.trim();
  if (smtpPassword.remove) patch.smtpPassword = null;
  else if (smtpPassword.value) patch.smtpPassword = smtpPassword.value;
  const dirty = Object.keys(patch).length > 0;
  const status = emailStatus(test.data?.settings ?? settings);
  const environment = saved.source === "environment";
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">How the server sends email: sign-up confirmation, forgot password, account deletion and email sign-in codes all need it.</p>
      <p className={`settings-status is-${status.tone}`} role="status"><Icon name={status.tone === "ok" ? "check-circle" : "alert"} size={13} /> {status.text}</p>
      <div className="eng-group">
        <h3 className="eng-group-title">Delivery</h3>
        <Row label="Send email with" hint="SendGrid needs an API key; SMTP works with most mail services and your own mail server." locked={isLocked("provider")}>
          <select aria-label="Email provider" value={draft.provider} disabled={isLocked("provider")} onChange={(event) => setDraft({ ...draft, provider: event.target.value as EmailProvider })}>
            <option value="none">Nothing (email off)</option>
            <option value="sendgrid">SendGrid</option>
            <option value="smtp">SMTP</option>
          </select>
        </Row>
        <Row label="Sender address" hint="The From address. Your provider may require it to be verified." locked={isLocked("fromAddress")}>
          <input type="email" aria-label="Sender address" value={draft.fromAddress} disabled={isLocked("fromAddress")} placeholder="rp@example.org" onChange={(event) => setDraft({ ...draft, fromAddress: event.target.value })} />
        </Row>
        <Row label="Sender name" hint="Shown beside the address. Blank uses TracyHill RP." locked={isLocked("fromName")}>
          <input type="text" aria-label="Sender name" value={draft.fromName} disabled={isLocked("fromName")} placeholder="TracyHill RP" onChange={(event) => setDraft({ ...draft, fromName: event.target.value })} />
        </Row>
      </div>
      {draft.provider === "sendgrid" ? (
        <div className="eng-group">
          <h3 className="eng-group-title">SendGrid</h3>
          <Row label="API key" hint="Created in SendGrid with the Mail Send permission. Stored encrypted; never shown again." locked={isLocked("sendgridApiKey")}>
            <SecretInput label="SendGrid API key" summary={saved.sendgridApiKey} draft={sendgridKey} onChange={setSendgridKey} locked={isLocked("sendgridApiKey")} />
          </Row>
        </div>
      ) : null}
      {draft.provider === "smtp" && !environment ? (
        <div className="eng-group">
          <h3 className="eng-group-title">SMTP</h3>
          <Row label="Server" hint="The host name, without smtp:// or a port.">
            <input type="text" aria-label="SMTP server" value={draft.smtpHost} placeholder="smtp.example.org" onChange={(event) => setDraft({ ...draft, smtpHost: event.target.value })} />
          </Row>
          <Row label="Port and encryption" hint="Usually 587 with STARTTLS, or 465 with TLS. No encryption only for a relay on a network you trust.">
            <input type="number" aria-label="SMTP port" className="settings-port" min={1} max={65535} value={draft.smtpPort} onChange={(event) => setDraft({ ...draft, smtpPort: Number(event.target.value) || 0 })} />
            <select aria-label="SMTP encryption" value={draft.smtpSecurity} onChange={(event) => setDraft({ ...draft, smtpSecurity: event.target.value as SmtpSecurity })}>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </Row>
          <Row label="Username" hint="Blank when the server needs no sign-in.">
            <input type="text" aria-label="SMTP username" autoComplete="off" value={draft.smtpUsername} onChange={(event) => setDraft({ ...draft, smtpUsername: event.target.value })} />
          </Row>
          <Row label="Password" hint="For Gmail or Outlook, an app password. Stored encrypted; never shown again.">
            <SecretInput label="SMTP password" summary={saved.smtpPassword} draft={smtpPassword} onChange={setSmtpPassword} locked={false} />
          </Row>
        </div>
      ) : null}
      <SaveBar dirty={dirty} state={state} onSave={() => save({ email: patch })} />
      {draft.provider !== "none" ? (
        <div className="eng-group">
          <h3 className="eng-group-title">Test</h3>
          <Row label="Send a test email" hint={dirty ? "Save your changes first; the test uses the saved settings." : "Email counts as working once a test gets through."}>
            <input type="email" aria-label="Test email address" placeholder="you@example.org" value={testTo} onChange={(event) => setTestTo(event.target.value)} />
            <button type="button" className="secondary-button" disabled={dirty || test.isPending || !testTo.trim()} onClick={() => test.mutate({ to: testTo })}>{test.isPending ? "Sending…" : "Send test"}</button>
          </Row>
          {test.error ? <p className="eng-hint settings-error">{test.error.message}</p> : null}
          {test.data ? <p className={`eng-hint ${test.data.ok ? "settings-ok" : "settings-error"}`}>{test.data.ok ? `Sent. Check ${test.data.settings.email.lastTest?.to ?? "the inbox"}.` : `Not sent: ${test.data.error}`}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// Shared provider keys carry clear warnings that everything here is open to every account, and that a shared Claude
// or ChatGPT sign-in may get that subscription banned.
export function SharedKeysPage({ settings, save, state }: PageProps) {
  const [drafts, setDrafts] = useState<Record<string, SecretDraft>>({});
  const [acceptedBanRisk, setAcceptedBanRisk] = useState(false);
  const patch: Record<string, string | null> = {};
  for (const { id } of API_KEY_PROVIDERS) {
    const draft = drafts[id];
    if (draft?.remove) patch[id] = null;
    else if (draft?.value.trim()) patch[id] = draft.value.trim();
  }
  const dirty = Object.keys(patch).length > 0;
  const openSignUp = settings.accounts.registration === "open";
  return (
    <div className="eng-page-inner">
      <div className="settings-warning" role="note">
        <strong><Icon name="alert" size={14} /> Open to every account on this server</strong>
        <p>
          Keys and sign-ins entered on this page are openly accessible to the entire userbase of this server. Anyone with an
          account can run models on them, and you pay for everything they use. Nobody can read a key back, but every account
          without a key of its own spends yours.
        </p>
        {openSignUp ? <p>Sign-up is open (Accounts page), so anyone who can reach this server can make an account and spend on these.</p> : null}
      </div>
      <div className="eng-group">
        <h3 className="eng-group-title">API keys</h3>
        <p className="eng-hint settings-textarea-hint">A key an account adds for itself (Providers) is used for that account instead. Stored encrypted; never shown again.</p>
        {API_KEY_PROVIDERS.map(({ id, label, detail }) => {
          const summary = settings.sharedKeys[id] ?? { source: "none" as const, configured: false, last4: null };
          const locked = settings.locked.includes(`sharedKeys.${id}`);
          return (
            <Row key={id} label={label} hint={detail} locked={locked}>
              <SecretInput label={`Shared ${label} API key`} summary={summary} draft={drafts[id] ?? KEEP} onChange={(next) => setDrafts({ ...drafts, [id]: next })} locked={locked} />
            </Row>
          );
        })}
      </div>
      <SaveBar dirty={dirty} state={state} onSave={() => save({ sharedKeys: patch })} />
      <div className="eng-group">
        <h3 className="eng-group-title">Subscriptions</h3>
        <div className="settings-warning" role="note">
          <strong><Icon name="alert" size={14} /> Sharing a subscription may get it banned</strong>
          <p>
            Anthropic enforces against routing other people's traffic through a Claude subscription, and OpenAI's terms
            forbid sharing a ChatGPT account. Either company may suspend or ban the account you connect here for sharing it.
          </p>
          <label className="settings-check">
            <input type="checkbox" aria-label="I accept the ban risk" checked={acceptedBanRisk} onChange={(event) => setAcceptedBanRisk(event.target.checked)} />
            <span>I understand that the Claude or ChatGPT account I connect here may be banned for sharing.</span>
          </label>
        </div>
        <SubscriptionCards open seed={null} shared={{ calls: SERVER_SUBSCRIPTION_CALLS, connectBlocked: acceptedBanRisk ? null : "Tick the box above to connect." }} />
      </div>
    </div>
  );
}

export function SessionsPage({ settings, save, state }: PageProps) {
  const [draft, setDraft] = useState(settings.sessions);
  const changes = changedFields(settings.sessions, draft);
  const dirty = Object.keys(changes).length > 0;
  const zones = knownTimeZones();
  const here = browserTimeZone();
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">When everyone is signed out each day. Pick an hour when nobody plays.</p>
      <div className="eng-group">
        <h3 className="eng-group-title">Daily sign-out</h3>
        <Row label="Sign-out hour" hint="A session used in the four hours before this time lasts until the next day's, so nobody is cut off mid-scene.">
          <select aria-label="Sign-out hour" value={draft.signOutHour} onChange={(event) => setDraft({ ...draft, signOutHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}
          </select>
        </Row>
        <Row label="Time zone" hint={here && here !== draft.timeZone ? <>This browser is in {here}. <button type="button" className="settings-link" onClick={() => setDraft({ ...draft, timeZone: here })}>Use it</button></> : "The zone the hour above is in."}>
          <input type="text" aria-label="Time zone" list="server-settings-zones" value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} />
          <datalist id="server-settings-zones">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
        </Row>
      </div>
      <SaveBar dirty={dirty} state={state} onSave={() => save({ sessions: changes })} />
    </div>
  );
}

export function NewSessionsPage({ settings, save, state }: PageProps) {
  const saved = settings.sessionDefaults;
  const [draft, setDraft] = useState({ worldStance: saved.worldStance, depictionTier: saved.depictionTier });
  const changes = changedFields({ worldStance: saved.worldStance, depictionTier: saved.depictionTier }, draft);
  const dirty = Object.keys(changes).length > 0;
  const builtIn = (value: number, builtInValue: number) => (value === builtInValue ? " (the built-in default)" : "");
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">
        Where a new session starts, for everyone on this server. A session added to a campaign takes the campaign's newest session's settings instead.
        Each session can still be changed in its Engine panel by an administrator; other accounts cannot change these two.
      </p>
      <div className="eng-group">
        <h3 className="eng-group-title">Content</h3>
        <Row label="World stance" hint={`How causality resolves relative to the player. Lower it if children use this server.${builtIn(draft.worldStance, saved.builtIn.worldStance)}`}>
          <select aria-label="Starting world stance" value={draft.worldStance} onChange={(event) => setDraft({ ...draft, worldStance: Number(event.target.value) })}>
            {STANCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Row>
        <Row label="Depiction tier" hint={`How explicitly consequence is rendered. Lower it if children use this server.${builtIn(draft.depictionTier, saved.builtIn.depictionTier)}`}>
          <select aria-label="Starting depiction tier" value={draft.depictionTier} onChange={(event) => setDraft({ ...draft, depictionTier: Number(event.target.value) })}>
            {TIER_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Row>
      </div>
      <SaveBar dirty={dirty} state={state} onSave={() => save({ sessionDefaults: changes })} />
    </div>
  );
}

/** The ALLOWED_IPS entries as the server reads them (comma-separated); blank means every address, shown as "*". */
export function allowedAddresses(value: string): string[] {
  const addresses = value.split(",").map((part) => part.trim()).filter(Boolean);
  return addresses.length ? [...new Set(addresses)] : ["*"];
}

export function ServerPage({ settings }: { settings: ServerSettings }) {
  const env = settings.environment;
  const panel = (configured: boolean) => (configured ? "Set up" : "Not set up");
  return (
    <div className="eng-page-inner">
      <p className="eng-blurb">These come from the server's .env file and apply when it starts. They are read-only here: a wrong value could lock everyone out. ENVIRONMENT.md in the repository explains each one.</p>
      <div className="eng-group">
        <h3 className="eng-group-title">Network</h3>
        <Row label="Reverse proxy (TRUST_PROXY)" hint="Set when HTTPS is provided by a proxy in front of the app; it marks sign-in cookies secure."><span className="settings-value">{env.trustProxy || "false"}</span></Row>
        <Row label="Allowed addresses (ALLOWED_IPS)" hint="* lets every address reach the app.">
          {/* One chip per address, wrapping inside the value column: a long list ran over its label as one string (2026-10-02). */}
          <span className="settings-value-list">
            {allowedAddresses(env.allowedIps).map((address) => <span key={address} className="settings-value settings-chip">{address}</span>)}
          </span>
        </Row>
      </div>
      <div className="eng-group">
        <h3 className="eng-group-title">Coding panels</h3>
        <Row label="Claude Code" hint="CLAUDE_CODE_HOST and CLAUDE_CODE_SECRET"><span className="settings-value">{panel(env.codingPanels.claudeCode)}</span></Row>
        <Row label="Codex" hint="CODEX_HOST and CODEX_SECRET"><span className="settings-value">{panel(env.codingPanels.codex)}</span></Row>
        <Row label="Kimi (K3)" hint="KIMI_CODE_HOST and KIMI_CODE_SECRET"><span className="settings-value">{panel(env.codingPanels.kimi)}</span></Row>
      </div>
    </div>
  );
}
