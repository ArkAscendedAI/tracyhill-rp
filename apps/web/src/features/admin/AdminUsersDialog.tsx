import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AdminUser, Role } from "@tracyhill-rp/contracts";

import {
  createAdminUser,
  deleteAdminUser,
  resetAdminUserTwoFactor,
  getAdminUserSessionDetail,
  getAdminUserSessions,
  getAdminUsers,
  resetAdminUserPassword,
  updateAdminUserRole,
} from "./adminApi";
import { removeDeletedUser } from "./adminUsersCache";
import { InviteLinks } from "./InviteLinks";
import { Dialog } from "../../shared/ui/Dialog";

type AdminUsersDialogProps = {
  open: boolean;
  currentUserId: string;
  onClose: () => void;
};

export function AdminUsersDialog({ open, currentUserId, onClose }: AdminUsersDialogProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [resettingUser, setResettingUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<AdminUser | null>(null);
  const [confirmingRoleId, setConfirmingRoleId] = useState<string | null>(null);
  // A lost phone: the account awaiting the reset confirmation, and the last reset done.
  const [confirmingTwoFactorReset, setConfirmingTwoFactorReset] = useState<AdminUser | null>(null);
  const [twoFactorResetDone, setTwoFactorResetDone] = useState<string | null>(null);
  const [viewingUser, setViewingUser] = useState<AdminUser | null>(null);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: getAdminUsers,
    enabled: open,
  });
  const sessionsQuery = useQuery({
    queryKey: ["admin-user-sessions", viewingUser?.id],
    queryFn: () => getAdminUserSessions(viewingUser!.id),
    enabled: open && Boolean(viewingUser),
  });
  const sessionDetailQuery = useQuery({
    queryKey: ["admin-user-session-detail", viewingUser?.id, viewingSessionId],
    queryFn: () => getAdminUserSessionDetail(viewingUser!.id, viewingSessionId!),
    enabled: open && Boolean(viewingUser) && Boolean(viewingSessionId),
  });

  const invalidateUsers = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    if (viewingUser) await queryClient.invalidateQueries({ queryKey: ["admin-user-sessions", viewingUser.id] });
  };
  const createMutation = useMutation({
    mutationFn: createAdminUser,
    onSuccess: async () => {
      setCreating(false);
      setUsername("");
      setPassword("");
      setEmail("");
      setRole("user");
      await invalidateUsers();
    },
  });
  const resetMutation = useMutation({
    mutationFn: ({ userId, value }: { userId: string; value: string }) => resetAdminUserPassword(userId, { password: value }),
    onSuccess: async () => {
      setResettingUser(null);
      setResetPassword("");
      await invalidateUsers();
    },
  });
  const roleMutation = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: Role }) => updateAdminUserRole(userId, { role: nextRole }),
    onSuccess: invalidateUsers,
  });
  const deleteMutation = useMutation({
    mutationFn: deleteAdminUser,
    onSuccess: async (_response, userId) => {
      if (viewingUser?.id === userId) {
        setViewingUser(null);
        setViewingSessionId(null);
      }
      setConfirmingDelete(null);
      removeDeletedUser(queryClient, userId);
      await invalidateUsers();
    },
  });

  const twoFactorResetMutation = useMutation({
    mutationFn: resetAdminUserTwoFactor,
    onSuccess: () => {
      setTwoFactorResetDone(confirmingTwoFactorReset?.username ?? null);
      setConfirmingTwoFactorReset(null);
    },
  });

  const busy = usersQuery.isLoading || createMutation.isPending || resetMutation.isPending || roleMutation.isPending || deleteMutation.isPending || twoFactorResetMutation.isPending;
  const users = usersQuery.data?.users ?? [];
  const currentSessionList = sessionsQuery.data?.sessions ?? [];
  const configuredProviderCount = (user: AdminUser) => Object.values(user.providerKeys).filter(Boolean).length;
  const actionError = createMutation.error?.message
    ?? resetMutation.error?.message
    ?? roleMutation.error?.message
    ?? deleteMutation.error?.message
    ?? twoFactorResetMutation.error?.message
    ?? usersQuery.error?.message
    ?? sessionsQuery.error?.message
    ?? sessionDetailQuery.error?.message
    ?? null;
  const title = useMemo(() => {
    if (sessionDetailQuery.data) return sessionDetailQuery.data.session.name;
    if (viewingUser) return `${viewingUser.username}'s Sessions`;
    if (resettingUser) return `Reset ${resettingUser.username}`;
    if (creating) return "Create User";
    if (confirmingDelete) return `Delete ${confirmingDelete.username}`;
    if (confirmingTwoFactorReset) return `Reset Two-Step Sign-In`;
    if (invitesOpen) return "Invite Links";
    return "Users";
  }, [confirmingDelete, confirmingTwoFactorReset, creating, invitesOpen, resettingUser, sessionDetailQuery.data, viewingUser]);

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} label="Users" eyebrow="Admin" title={title} icon="users" size="lg" className="admin-users-dialog" closeDisabled={createMutation.isPending || resetMutation.isPending || roleMutation.isPending || deleteMutation.isPending}>
        <div className="stack stack-tight">
          {actionError ? <p className="error">{actionError}</p> : null}
          {usersQuery.isLoading ? <p className="muted small-copy">Loading users...</p> : null}
          {sessionDetailQuery.data ? (
            <div className="stack stack-tight">
              <div className="row gap-sm">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setViewingSessionId(null)}>
                  Back
                </button>
                <p className="muted small-copy">{sessionDetailQuery.data.username}</p>
              </div>
              <div className="stack stack-tight" style={{ maxHeight: 360, overflowY: "auto" }}>
                {sessionDetailQuery.data.messages.map((message) => (
                  <article key={message.id} className="card stack stack-tight">
                    <div className="section-head">
                      <strong style={{ textTransform: "capitalize" }}>{message.role}</strong>
                      <span className="muted small-copy">{new Date(message.createdAt).toLocaleString()}</span>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{message.content}</p>
                  </article>
                ))}
                {sessionDetailQuery.data.messages.length === 0 ? <p className="muted small-copy">No messages yet.</p> : null}
              </div>
            </div>
          ) : viewingUser ? (
            <div className="stack stack-tight">
              <div className="row gap-sm">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setViewingUser(null)}>
                  Back
                </button>
                <p className="muted small-copy">{viewingUser.username}</p>
              </div>
              <div className="stack stack-tight" style={{ maxHeight: 360, overflowY: "auto" }}>
                {currentSessionList.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="card stack stack-tight"
                    style={{ textAlign: "left" }}
                    onClick={() => setViewingSessionId(session.id)}
                  >
                    <strong style={session.deletedAt ? { opacity: 0.6 } : undefined}>{session.name}{session.deletedAt ? " (deleted)" : ""}</strong>
                    <span className="muted small-copy">
                      {session.modelId ?? "unknown model"} · {session.messageCount} msgs
                      {/* Recycle-bin sessions ship deletedAt but used to be indistinguishable from live ones. */}
                      {session.deletedAt ? ` · in recycle bin since ${new Date(session.deletedAt).toLocaleString()}` : ""}
                    </span>
                  </button>
                ))}
                {sessionsQuery.isSuccess && currentSessionList.length === 0 ? <p className="muted small-copy">No sessions.</p> : null}
              </div>
            </div>
          ) : resettingUser ? (
            <div className="stack stack-tight">
              <p className="muted small-copy">Reset password for <strong>{resettingUser.username}</strong>.</p>
              <label className="stack stack-tight">
                <span>New Password</span>
                <input aria-label={`Reset password for ${resettingUser.username}`} type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
              </label>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setResettingUser(null)}>
                  Cancel
                </button>
                <button type="button" disabled={busy || !resetPassword} onClick={() => resetMutation.mutate({ userId: resettingUser.id, value: resetPassword })}>
                  Reset Password
                </button>
              </div>
            </div>
          ) : creating ? (
            <div className="stack stack-tight">
              <label className="stack stack-tight">
                <span>Username</span>
                <input aria-label="Admin create username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label className="stack stack-tight">
                <span>Password</span>
                <input aria-label="Admin create password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <label className="stack stack-tight">
                <span>Email (optional)</span>
                <input aria-label="Admin create email" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
                <span className="muted small-copy">Stored as verified — gives the member a working MFA / self-delete channel from day one. They can change it later from Options → MFA.</span>
              </label>
              <label className="stack stack-tight">
                <span>Role</span>
                <select aria-label="Admin create role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button type="button" disabled={busy || !username.trim() || !password} onClick={() => createMutation.mutate({ username, password, role, ...(email.trim() ? { email: email.trim() } : {}) })}>
                  Create User
                </button>
              </div>
            </div>
          ) : confirmingTwoFactorReset ? (
            <div className="stack stack-tight">
              <p>Reset two-step sign-in for <strong>{confirmingTwoFactorReset.username}</strong>?</p>
              <p className="muted small-copy">Their authenticator app, recovery codes and trusted devices are removed. If this server requires two-step sign-in, they set up a new authenticator at their next sign-in.</p>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingTwoFactorReset(null)}>
                  Cancel
                </button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => twoFactorResetMutation.mutate(confirmingTwoFactorReset.id)}>
                  Confirm Reset
                </button>
              </div>
            </div>
          ) : invitesOpen ? (
            <InviteLinks onBack={() => { setInvitesOpen(false); void invalidateUsers(); }} />
          ) : confirmingDelete ? (
            <div className="stack stack-tight">
              <p className="error">Delete user <strong>{confirmingDelete.username}</strong> and all owned data?</p>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingDelete(null)}>
                  Cancel
                </button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => deleteMutation.mutate(confirmingDelete.id)}>
                  Confirm Delete User
                </button>
              </div>
            </div>
          ) : (
            <div className="stack stack-tight">
              {twoFactorResetDone ? <p className="muted small-copy" role="status">Two-step sign-in was reset for {twoFactorResetDone}.</p> : null}
              <div className="stack stack-tight" style={{ maxHeight: 360, overflowY: "auto" }}>
                {users.map((user) => {
                  const isSelf = user.id === currentUserId;
                  const nextRole = user.role === "admin" ? "user" : "admin";
                  return (
                    <article key={user.id} className="card stack stack-tight">
                      <div className="section-head">
                        <strong>{user.username}</strong>
                        <span className="muted small-copy">{configuredProviderCount(user)} provider keys · {user.sessionCount} sessions</span>
                      </div>
                      <div className="row gap-sm wrap-row">
                        {confirmingRoleId === user.id ? (
                          <>
                            <button
                              type="button"
                              className="danger-button"
                              disabled={busy}
                              onClick={() => { roleMutation.mutate({ userId: user.id, nextRole }); setConfirmingRoleId(null); }}
                            >
                              Make {nextRole}?
                            </button>
                            <button type="button" className="ghost-button" onClick={() => setConfirmingRoleId(null)}>Cancel</button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy || isSelf}
                            onClick={() => setConfirmingRoleId(user.id)}
                            title={`Change role to ${nextRole}`}
                          >
                            Role: {user.role}
                          </button>
                        )}
                        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setViewingUser(user); setViewingSessionId(null); }}>
                          Sessions
                        </button>
                        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setResettingUser(user); setResetPassword(""); }}>
                          Reset PW
                        </button>
                        <button type="button" className="secondary-button" disabled={busy} title="Remove their authenticator, recovery codes and trusted devices (a lost phone)" onClick={() => { setTwoFactorResetDone(null); setConfirmingTwoFactorReset(user); }}>
                          Reset 2FA
                        </button>
                        {!isSelf ? (
                          <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmingDelete(user)}>
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
                  Close
                </button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setInvitesOpen(true)}>
                  Invite Links
                </button>
                <button type="button" disabled={busy} onClick={() => setCreating(true)}>
                  New User
                </button>
              </div>
            </div>
          )}
        </div>
    </Dialog>
  );
}
