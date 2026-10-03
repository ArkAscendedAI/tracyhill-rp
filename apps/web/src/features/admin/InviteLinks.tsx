import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CreateInviteResponse, Invite, Role } from "@tracyhill-rp/contracts";

import { ADMIN_INVITES_QUERY_KEY, createInvite, getInvites, revokeInvite } from "./adminApi";

// Invite links in Admin: Users. One link makes one account, with
// sign-up off and without email; the person picks a username (unless the link fixes one) and a password.

const DAY_CHOICES = [1, 3, 7, 14, 30];

export function inviteLink(origin: string, token: string) {
  return `${origin}/invite/${token}`;
}

export function describeInvite(invite: Invite): string {
  const date = (value: string | null) => (value ? new Date(value).toLocaleDateString() : "");
  const who = invite.username ? `for ${invite.username}` : "username of their choice";
  const role = invite.role === "admin" ? "Admin" : "User";
  switch (invite.status) {
    case "open": return `${role}, ${who}. Open until ${date(invite.expiresAt)}.`;
    case "used": return `${role}, ${who}. Used ${date(invite.usedAt)}.`;
    case "expired": return `${role}, ${who}. Expired ${date(invite.expiresAt)}.`;
    case "revoked": return `${role}, ${who}. Withdrawn ${date(invite.revokedAt)}.`;
  }
}

export function InviteLinks({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<Role>("user");
  const [username, setUsername] = useState("");
  const [days, setDays] = useState(7);
  // The link just made: its token is shown this once.
  const [made, setMade] = useState<CreateInviteResponse | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const invites = useQuery({ queryKey: ADMIN_INVITES_QUERY_KEY, queryFn: getInvites });
  const create = useMutation({
    mutationFn: createInvite,
    onSuccess: (response) => {
      setMade(response);
      setCopied(null);
      setUsername("");
      void queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: revokeInvite,
    onSuccess: () => {
      setConfirmingRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY });
    },
  });
  const busy = create.isPending || revoke.isPending;
  const link = made ? inviteLink(window.location.origin, made.token) : "";
  const list = invites.data?.invites ?? [];
  const error = create.error?.message ?? revoke.error?.message ?? invites.error?.message ?? null;

  return (
    <div className="stack stack-tight">
      <div className="row gap-sm">
        <button type="button" className="secondary-button" disabled={busy} onClick={onBack}>Back</button>
      </div>
      <p className="muted small-copy">
        An invite link lets one person create their own account, even with sign-up off and without email. Send it any way you like. It works once, until it expires.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {made ? (
        <div className="placeholder-card stack stack-tight">
          <strong>Your invite link</strong>
          <p className="muted small-copy">Copy it now: it is not shown again. Anyone who has it can use it.</p>
          <div className="row gap-sm wrap-row">
            <input aria-label="Invite link" readOnly value={link} onFocus={(event) => event.target.select()} style={{ flex: 1, minWidth: 0 }} />
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (!navigator.clipboard) { setCopied("no"); return; }
                void navigator.clipboard.writeText(link).then(() => setCopied("yes"), () => setCopied("no"));
              }}
            >
              {copied === "yes" ? "Copied" : "Copy link"}
            </button>
          </div>
          {copied === "no" ? <p className="muted small-copy">This browser would not copy it here. Select the link in the box and copy it yourself.</p> : null}
        </div>
      ) : null}
      <div className="placeholder-card stack stack-tight">
        <strong>New invite link</strong>
        <div className="row gap-sm wrap-row">
          <label className="stack stack-tight">
            <span className="muted small-copy">Role</span>
            <select aria-label="Invite role" value={role} disabled={busy} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="stack stack-tight">
            <span className="muted small-copy">Username (optional)</span>
            <input aria-label="Invite username" placeholder="They choose" maxLength={30} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="stack stack-tight">
            <span className="muted small-copy">Works for</span>
            <select aria-label="Invite lifetime" value={days} disabled={busy} onChange={(event) => setDays(Number(event.target.value))}>
              {DAY_CHOICES.map((value) => <option key={value} value={value}>{value === 1 ? "1 day" : `${value} days`}</option>)}
            </select>
          </label>
        </div>
        {role === "admin" ? <p className="muted small-copy">The new account will be an administrator, with everything you can do.</p> : null}
        <div className="row gap-sm end">
          <button type="button" disabled={busy} onClick={() => create.mutate({ role, days, ...(username.trim() ? { username: username.trim() } : {}) })}>
            {create.isPending ? "Creating..." : "Create Link"}
          </button>
        </div>
      </div>
      <div className="stack stack-tight" style={{ maxHeight: 260, overflowY: "auto" }}>
        {invites.isLoading ? <p className="muted small-copy">Loading invites...</p> : null}
        {invites.isSuccess && list.length === 0 ? <p className="muted small-copy">No invite links yet.</p> : null}
        {list.map((invite) => (
          <article key={invite.id} className="card stack stack-tight">
            <div className="section-head">
              <span className="small-copy">{describeInvite(invite)}</span>
              {invite.status === "open" ? (
                confirmingRevoke === invite.id ? (
                  <span className="row gap-sm">
                    <button type="button" className="danger-button" disabled={busy} onClick={() => revoke.mutate(invite.id)}>Withdraw link?</button>
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => setConfirmingRevoke(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingRevoke(invite.id)}>Withdraw</button>
                )
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
