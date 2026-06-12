import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient, userPreferences, users } from "@tracyhill-rp/db";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";
import { hashPassword } from "../../lib/password";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  delete process.env.EXPOSE_AUTH_CODES;
  while (cleanups.length) cleanups.pop()?.();
});

describe("auth routes", () => {
  it("supports public self-service registration", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    const register = await agent.post("/api/auth/register").send({
      username: "registered-user",
      email: "registered@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    });
    expect(register.status).toBe(201);
    expect(register.body.verificationRequired).toBe(true);
    expect(register.body.registrationToken).toBeTruthy();
    expect(register.body.devVerificationCode).toMatch(/^\d{6}$/);

    const verify = await agent.post("/api/auth/register/verify").send({
      registrationToken: register.body.registrationToken,
      code: register.body.devVerificationCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.user.username).toBe("registered-user");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.username).toBe("registered-user");
  });

  it("supports registration code resend", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    const register = await agent.post("/api/auth/register").send({
      username: "registered-user-2",
      email: "registered-2@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    });
    expect(register.status).toBe(201);

    const resend = await agent.post("/api/auth/register/resend").send({
      registrationToken: register.body.registrationToken,
    });
    expect(resend.status).toBe(200);
    expect(resend.body.devVerificationCode).toMatch(/^\d{6}$/);

    const verify = await agent.post("/api/auth/register/verify").send({
      registrationToken: register.body.registrationToken,
      code: resend.body.devVerificationCode,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.user.username).toBe("registered-user-2");
  });

  it("supports forgot-password reset without user enumeration", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    // Constant-shape response: non-existent user gets the same fields (resetToken + emailMasked)
    // as a real user, so an attacker can't distinguish existing vs. nonexistent accounts via
    // response-shape diffing.
    const missing = await agent.post("/api/auth/forgot-password").send({ username: "missing-user" });
    expect(missing.status).toBe(200);
    expect(missing.body.ok).toBe(true);
    expect(typeof missing.body.resetToken).toBe("string");
    expect(missing.body.resetToken.length).toBeGreaterThan(0);
    expect(typeof missing.body.emailMasked).toBe("string");
    // No real email is sent for nonexistent users, so no dev code is exposed even with
    // EXPOSE_AUTH_CODES=1. This is the only externally-observable difference and is acceptable
    // because EXPOSE_AUTH_CODES is dev-only and refuses to start in production.
    expect(missing.body.devVerificationCode).toBeUndefined();
    // The dummy resetToken should never let an attacker continue the flow successfully.
    const dummyVerify = await agent.post("/api/auth/forgot-password/verify").send({
      resetToken: missing.body.resetToken,
      code: "000000",
    });
    expect(dummyVerify.status).toBe(401);
    const dummyReset = await agent.post("/api/auth/forgot-password/reset").send({
      resetToken: missing.body.resetToken,
      newPassword: "AttackerPass9A",
    });
    expect(dummyReset.status).toBe(400);

    const requestReset = await agent.post("/api/auth/forgot-password").send({ username: minimalUser.username });
    expect(requestReset.status).toBe(200);
    expect(requestReset.body.resetToken).toBeTruthy();
    expect(requestReset.body.devVerificationCode).toMatch(/^\d{6}$/);

    const resend = await agent.post("/api/auth/forgot-password/resend").send({
      resetToken: requestReset.body.resetToken,
    });
    expect(resend.status).toBe(200);
    expect(resend.body.devVerificationCode).toMatch(/^\d{6}$/);

    const verify = await agent.post("/api/auth/forgot-password/verify").send({
      resetToken: requestReset.body.resetToken,
      code: resend.body.devVerificationCode,
    });
    expect(verify.status).toBe(200);

    const reset = await agent.post("/api/auth/forgot-password/reset").send({
      resetToken: requestReset.body.resetToken,
      newPassword: "ResetPass9A",
    });
    expect(reset.status).toBe(200);

    const login = await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: "ResetPass9A",
    });
    expect(login.status).toBe(200);
  });

  it("requires MFA verification for email-verified users", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    const register = await agent.post("/api/auth/register").send({
      username: "mfa-user",
      email: "mfa-user@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    });
    expect(register.status).toBe(201);

    const verifyRegistration = await agent.post("/api/auth/register/verify").send({
      registrationToken: register.body.registrationToken,
      code: register.body.devVerificationCode,
    });
    expect(verifyRegistration.status).toBe(200);

    await agent.post("/api/auth/logout");
    const login = await agent.post("/api/auth/login").send({
      username: "mfa-user",
      password: "DemoPass9A",
    });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.devVerificationCode).toMatch(/^\d{6}$/);

    const resend = await agent.post("/api/auth/mfa/resend").send({
      mfaSessionToken: login.body.mfaSessionToken,
    });
    expect(resend.status).toBe(200);

    const verifyMfa = await agent.post("/api/auth/mfa/verify").send({
      mfaSessionToken: login.body.mfaSessionToken,
      code: resend.body.devVerificationCode,
      trustDevice: true,
    });
    expect(verifyMfa.status).toBe(200);
    expect(verifyMfa.body.user.username).toBe("mfa-user");
    const verifySetCookies = Array.isArray(verifyMfa.headers["set-cookie"])
      ? verifyMfa.headers["set-cookie"]
      : verifyMfa.headers["set-cookie"] ? [verifyMfa.headers["set-cookie"]] : [];
    expect(verifySetCookies.join(";")).toMatch(/trp\.trust=/);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.username).toBe("mfa-user");

    const trustedCookie = verifySetCookies.find((value: string) => value.startsWith("trp.trust="));
    expect(trustedCookie).toBeTruthy();
    const trustedAgent = request.agent(app);
    const trustedLogin = await trustedAgent.post("/api/auth/login")
      .set("Cookie", trustedCookie!.split(";")[0])
      .send({
        username: "mfa-user",
        password: "DemoPass9A",
      });
    expect(trustedLogin.status).toBe(200);
    expect(trustedLogin.body.ok).toBe(true);
    expect(trustedLogin.body.user.username).toBe("mfa-user");

    const trustedDevices = await agent.get("/api/account/mfa/trusted-devices");
    expect(trustedDevices.status).toBe(200);
    expect(trustedDevices.body.trustedDevices).toHaveLength(1);

    const mfaStatus = await agent.get("/api/account/mfa");
    expect(mfaStatus.status).toBe(200);
    expect(mfaStatus.body.enabled).toBe(true);
    expect(mfaStatus.body.emailVerified).toBe(true);
    expect(mfaStatus.body.emailMasked).toMatch(/^mf\*+@example\.com$/);
    expect(mfaStatus.body.trustedDevices).toHaveLength(1);

    // Ids are STABLE per-device values now (index-based revocation could
    // remove the wrong device when the list shifted) — read it from the list.
    const deviceId = mfaStatus.body.trustedDevices[0].id;
    const revoke = await agent.delete(`/api/account/mfa/trusted-devices/${deviceId}`);
    expect(revoke.status).toBe(200);

    const adminAuditAgent = request.agent(app);
    await adminAuditAgent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);
    const auditAfterRevoke = await adminAuditAgent.get("/api/admin/audit-events");
    expect(auditAfterRevoke.status).toBe(200);
    expect(auditAfterRevoke.body.events.some((event: { action: string; targetId: string }) => event.action === "account.mfa.trusted_device_revoked" && event.targetId === String(deviceId))).toBe(true);

    const loginAfterRevoke = await trustedAgent.post("/api/auth/login")
      .set("Cookie", trustedCookie!.split(";")[0])
      .send({
        username: "mfa-user",
        password: "DemoPass9A",
      });
    expect(loginAfterRevoke.status).toBe(200);
    expect(loginAfterRevoke.body.mfaRequired).toBe(true);
  });

  it("supports login, me, and logout", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    const login = await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe(minimalUser.username);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.username).toBe(minimalUser.username);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);
    const logoutSetCookies = Array.isArray(logout.headers["set-cookie"])
      ? logout.headers["set-cookie"]
      : logout.headers["set-cookie"] ? [logout.headers["set-cookie"]] : [];
    // Device trust deliberately SURVIVES logout now (clearing it forced full
    // verification on every sign-in while the server record lingered).
    expect(logoutSetCookies.join(";")).not.toMatch(/trp\.trust=;/);

    const meAfter = await agent.get("/api/auth/me");
    expect(meAfter.status).toBe(200);
    expect(meAfter.body).toEqual({ authenticated: false, user: null });
  });

  it("supports self-service password change", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    });

    const change = await agent.put("/api/account/password").send({
      currentPassword: minimalUser.password,
      newPassword: "DemoPass9A",
    });
    expect(change.status).toBe(200);
    expect(change.body).toEqual({ ok: true });

    await agent.post("/api/auth/logout");
    const relogin = await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: "DemoPass9A",
    });
    expect(relogin.status).toBe(200);

    const audit = await agent.get("/api/admin/audit-events");
    expect(audit.status).toBe(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "account.password.changed")).toBe(true);
  });

  it("supports self-service account deletion after delete-code verification when another admin exists", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const now = new Date().toISOString();
    db.insert(users).values({
      id: "admin-2",
      username: "second-admin",
      role: "admin",
      passwordHash: await hashPassword("SecondPass9A"),
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(userPreferences).values({
      userId: "admin-2",
      updatedAt: now,
    }).run();
    sqlite.close();
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    });

    const requestDeletion = await agent.post("/api/account/delete-request").send({});
    expect(requestDeletion.status).toBe(201);
    expect(requestDeletion.body.deleteToken).toBeTruthy();
    expect(requestDeletion.body.devVerificationCode).toMatch(/^\d{6}$/);

    const resendDeletion = await agent.post("/api/account/delete-request/send-code").send({
      deleteToken: requestDeletion.body.deleteToken,
    });
    expect(resendDeletion.status).toBe(200);
    expect(resendDeletion.body.devVerificationCode).toMatch(/^\d{6}$/);

    const confirmDeletion = await agent.post("/api/account/delete-confirm").send({
      deleteToken: requestDeletion.body.deleteToken,
      code: resendDeletion.body.devVerificationCode,
    });
    expect(confirmDeletion.status).toBe(200);
    expect(confirmDeletion.body).toEqual({ ok: true, verified: true });

    const deletion = await agent.delete("/api/account/delete-execute").send({
      deleteToken: requestDeletion.body.deleteToken,
    });
    expect(deletion.status).toBe(200);
    expect(deletion.body).toEqual({ ok: true });

    const meAfter = await agent.get("/api/auth/me");
    expect(meAfter.status).toBe(200);
    expect(meAfter.body).toEqual({ authenticated: false, user: null });

    const relogin = await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    });
    expect(relogin.status).toBe(401);

    const secondAdmin = request.agent(app);
    await secondAdmin.post("/api/auth/login").send({
      username: "second-admin",
      password: "SecondPass9A",
    }).expect(200);
    const audit = await secondAdmin.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "account.delete.requested")).toBe(true);
    expect(audit.body.events.some((event: { action: string }) => event.action === "account.delete.code_resent")).toBe(true);
    expect(audit.body.events.some((event: { action: string }) => event.action === "account.delete.confirmed")).toBe(true);
    expect(audit.body.events.some((event: { action: string }) => event.action === "account.deleted")).toBe(true);
  });

  it("blocks deleting the last admin account at delete execute time", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.EXPOSE_AUTH_CODES = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    });

    const requestDeletion = await agent.post("/api/account/delete-request").send({});
    expect(requestDeletion.status).toBe(201);

    const confirmDeletion = await agent.post("/api/account/delete-confirm").send({
      deleteToken: requestDeletion.body.deleteToken,
      code: requestDeletion.body.devVerificationCode,
    });
    expect(confirmDeletion.status).toBe(200);

    const deletion = await agent.delete("/api/account/delete-execute").send({
      deleteToken: requestDeletion.body.deleteToken,
    });
    expect(deletion.status).toBe(400);
    expect(deletion.body.error).toMatch(/last admin/i);
  });
});
