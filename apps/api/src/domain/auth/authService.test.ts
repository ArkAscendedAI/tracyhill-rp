import fs from "node:fs";

import { eq } from "drizzle-orm";
import session from "express-session";
import { afterEach, describe, expect, it } from "vitest";

import {
  campaignVersions,
  campaigns,
  createDatabaseClient,
  folders,
  generatedImages,
  messageAttachments,
  messages,
  pendingAssistantMessages,
  pipelineRuns,
  promptTemplates,
  sessions,
  userPreferences,
  users,
  wizardRuns,
  wizardTemplates,
} from "@tracyhill-rp/db";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { ImageStore } from "../images/imageStore";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { AuthEmailService } from "../../services/authEmail";
import { UserRepository } from "../users/userRepository";
import { AuthService } from "./authService";
import { createSeededTestDb } from "../../test/testDb";
import { hashPassword } from "../../lib/password";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function createSession() {
  return {} as session.Session & Partial<session.SessionData>;
}

function createAuthService(db: ReturnType<typeof createDatabaseClient>["db"], imageDir: string) {
  return new AuthService(
    new UserRepository(db),
    new GeneratedImageRepository(db),
    new ImageStore(imageDir),
    new AuthEmailService({
      sendgridApiKey: "",
      emailFrom: "noreply@example.com",
      emailFromName: "TracyHill RP",
      exposeAuthCodes: true,
    }),
  );
}

function expectAuthenticatedLogin(
  result: Awaited<ReturnType<AuthService["login"]>>,
): NonNullable<Exclude<Awaited<ReturnType<AuthService["login"]>>, { mfaRequired: true }>> {
  expect(result).toBeTruthy();
  expect(result && "mfaRequired" in result).toBe(false);
  if (!result || "mfaRequired" in result) throw new Error("expected direct login result");
  return result;
}

describe("AuthService", () => {
  it("logs in with valid credentials", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const reqSession = createSession();
    const user = expectAuthenticatedLogin(
      await service.login({ username: minimalUser.username, password: minimalUser.password }, reqSession),
    );
    sqlite.close();
    expect(user.username).toBe(minimalUser.username);
    expect(reqSession.userId).toBe(minimalUser.id);
  });

  it("registers with verification and authenticates after the code is confirmed", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const reqSession = createSession();
    const registration = await service.register({
      username: "new_user",
      email: "NEW_USER@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    }, reqSession);
    expect(registration.verificationRequired).toBe(true);
    expect(registration.devVerificationCode).toMatch(/^\d{6}$/);
    const created = new UserRepository(db).findByUsername("new_user");
    expect(created).toBeUndefined();
    const user = await service.verifyRegistration({
      registrationToken: registration.registrationToken,
      code: registration.devVerificationCode!,
    }, reqSession);
    const verified = new UserRepository(db).findByUsername("new_user");
    sqlite.close();
    expect(user.username).toBe("new_user");
    expect(verified?.email).toBe("new_user@example.com");
    expect(verified?.emailVerified).toBe(1);
    expect(reqSession.userId).toBe(user.id);
    expect(reqSession.role).toBe("user");
  });

  it("rejects invalid credentials", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const reqSession = createSession();
    const user = await service.login({ username: minimalUser.username, password: "wrong-pass" }, reqSession);
    sqlite.close();
    expect(user).toBeNull();
    expect(reqSession.userId).toBeUndefined();
  });

  it("rejects registration when the email is already taken", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    await expect(service.register({
      username: "second-user",
      email: "demo@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    }, createSession())).rejects.toMatchObject({ statusCode: 409 });
    sqlite.close();
  });

  it("supports forgot-password verification and reset", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const request = await service.requestPasswordReset({ username: minimalUser.username });
    if (!("resetToken" in request) || !request.resetToken || !("devVerificationCode" in request) || !request.devVerificationCode) {
      throw new Error("expected reset token and dev verification code");
    }
    expect(request.resetToken).toBeTruthy();
    expect(request.devVerificationCode).toMatch(/^\d{6}$/);
    await service.verifyPasswordReset({
      resetToken: request.resetToken!,
      code: request.devVerificationCode!,
    });
    await service.resetPassword({
      resetToken: request.resetToken!,
      newPassword: "ResetPass9A",
    });
    const reqSession = createSession();
    const user = expectAuthenticatedLogin(
      await service.login({ username: minimalUser.username, password: "ResetPass9A" }, reqSession),
    );
    sqlite.close();
    expect(user.username).toBe(minimalUser.username);
  });

  it("requires a second-step MFA code for verified-email users", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const registration = await service.register({
      username: "mfa_user",
      email: "mfa_user@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    }, createSession());
    if (!registration.devVerificationCode) throw new Error("expected registration verification code");
    await service.verifyRegistration({
      registrationToken: registration.registrationToken,
      code: registration.devVerificationCode,
    }, createSession());
    const reqSession = createSession();
    const login = await service.login({ username: "mfa_user", password: "DemoPass9A" }, reqSession);
    if (!login || !("mfaRequired" in login) || !login.devVerificationCode) throw new Error("expected mfa challenge");
    expect(reqSession.userId).toBeUndefined();
    expect(login.mfaRequired).toBe(true);
    const user = await service.verifyMfaCode({
      mfaSessionToken: login.mfaSessionToken,
      code: login.devVerificationCode,
    }, reqSession);
    sqlite.close();
    expect(user.user.username).toBe("mfa_user");
    expect(reqSession.userId).toBe(user.user.id);
  });

  it("reuses a trusted device token to bypass later MFA login", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const registration = await service.register({
      username: "trusted_user",
      email: "trusted_user@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    }, createSession());
    if (!registration.devVerificationCode) throw new Error("expected registration verification code");
    await service.verifyRegistration({
      registrationToken: registration.registrationToken,
      code: registration.devVerificationCode,
    }, createSession());
    const mfaSession = createSession();
    const login = await service.login({ username: "trusted_user", password: "DemoPass9A" }, mfaSession);
    if (!login || !("mfaRequired" in login) || !login.devVerificationCode) throw new Error("expected mfa challenge");
    const verified = await service.verifyMfaCode({
      mfaSessionToken: login.mfaSessionToken,
      code: login.devVerificationCode,
      trustDevice: true,
    }, mfaSession, "Mozilla/5.0 Chrome/123 Windows");
    if (!verified.trustedDeviceToken) throw new Error("expected trusted device token");
    const secondSession = createSession();
    const trustedLogin = expectAuthenticatedLogin(
      await service.login({ username: "trusted_user", password: "DemoPass9A" }, secondSession, verified.trustedDeviceToken),
    );
    expect(trustedLogin.username).toBe("trusted_user");
    expect(service.listTrustedDevices(verified.user.id)).toHaveLength(1);
    sqlite.close();
  });

  it("reports MFA status with masked email and trusted devices", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const registration = await service.register({
      username: "status_user",
      email: "status_user@example.com",
      password: "DemoPass9A",
      agreedToTerms: true,
    }, createSession());
    if (!registration.devVerificationCode) throw new Error("expected registration verification code");
    const verifiedUser = await service.verifyRegistration({
      registrationToken: registration.registrationToken,
      code: registration.devVerificationCode,
    }, createSession());
    const mfaSession = createSession();
    const login = await service.login({ username: "status_user", password: "DemoPass9A" }, mfaSession);
    if (!login || !("mfaRequired" in login) || !login.devVerificationCode) throw new Error("expected mfa challenge");
    await service.verifyMfaCode({
      mfaSessionToken: login.mfaSessionToken,
      code: login.devVerificationCode,
      trustDevice: true,
    }, mfaSession, "Mozilla/5.0 Chrome/123 Windows");
    const status = service.getMfaStatus(verifiedUser.id);
    sqlite.close();
    expect(status.enabled).toBe(true);
    expect(status.emailVerified).toBe(true);
    expect(status.emailMasked).toMatch(/^st\*+@example\.com$/);
    expect(status.trustedDevices).toHaveLength(1);
  });

  it("returns and clears current user state", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const reqSession = createSession();
    reqSession.userId = minimalUser.id;
    reqSession.role = minimalUser.role;
    expect(service.currentUser(reqSession)).toEqual({
      authenticated: true,
      user: {
        id: minimalUser.id,
        username: minimalUser.username,
        role: minimalUser.role,
      },
    });
    service.logout(reqSession);
    sqlite.close();
    expect(reqSession.userId).toBeUndefined();
    expect(service.currentUser(reqSession)).toEqual({ authenticated: false, user: null });
  });

  it("changes password when the current password is valid", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    await service.changePassword(minimalUser.id, {
      currentPassword: minimalUser.password,
      newPassword: "DemoPass9A",
    });
    const reqSession = createSession();
    const user = expectAuthenticatedLogin(
      await service.login({ username: minimalUser.username, password: "DemoPass9A" }, reqSession),
    );
    sqlite.close();
    expect(user.username).toBe(minimalUser.username);
  });

  it("rejects password changes with the wrong current password", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    await expect(service.changePassword(minimalUser.id, {
      currentPassword: "wrong-pass",
      newPassword: "DemoPass9A",
    })).rejects.toMatchObject({ statusCode: 401 });
    sqlite.close();
  });

  it("deletes an account and its owned data after delete verification succeeds", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const now = new Date().toISOString();
    const imageStore = new ImageStore(seeded.imageDir);
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
    db.insert(folders).values({
      id: "folder-1",
      userId: minimalUser.id,
      name: "Folder",
      position: 0,
      collapsed: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(sessions).values({
      id: "session-1",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: "campaign-1",
      folderId: "folder-1",
      name: "Session",
      modelId: "openai:gpt-5-mini",
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      deletedAt: null,
    }).run();
    db.insert(messages).values({
      id: "message-1",
      sessionId: "session-1",
      userId: minimalUser.id,
      role: "assistant",
      content: "Persisted",
      modelId: "openai:gpt-5-mini",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(messageAttachments).values({
      id: "attachment-1",
      messageId: "message-1",
      sessionId: "session-1",
      userId: minimalUser.id,
      filename: "notes.txt",
      mimeType: "text/plain",
      contentMode: "inline",
      content: "hello",
      createdAt: now,
    }).run();
    db.insert(pendingAssistantMessages).values({
      id: "pending-1",
      sessionId: "session-1",
      userId: minimalUser.id,
      sourceUserMessageId: "message-1",
      modelId: "openai:gpt-5-mini",
      content: "Pending",
      createdAt: now,
      updatedAt: now,
    }).run();
    imageStore.write("image-1", "image/png", Uint8Array.from([137, 80, 78, 71]));
    db.insert(generatedImages).values({
      id: "image-1",
      messageId: "message-1",
      sessionId: "session-1",
      userId: minimalUser.id,
      prompt: "Prompt",
      mimeType: "image/png",
      createdAt: now,
    }).run();
    db.insert(campaigns).values({
      id: "campaign-1",
      userId: minimalUser.id,
      name: "Campaign",
      folderId: "folder-1",
      pipelineModelId: "openai:gpt-5-mini",
      systemPrompt: "System",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(campaignVersions).values({
      id: "campaign-version-1",
      campaignId: "campaign-1",
      userId: minimalUser.id,
      version: 1,
      systemPrompt: "System",
      createdAt: now,
      label: null,
    }).run();
    db.insert(promptTemplates).values({
      id: "template-1",
      userId: minimalUser.id,
      name: "Template",
      content: "Content",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(wizardTemplates).values({
      userId: minimalUser.id,
      exampleSystemPrompt: "System",
      updatedAt: now,
    }).run();
    db.insert(pipelineRuns).values({
      id: "pipeline-run-1",
      userId: minimalUser.id,
      campaignId: "campaign-1",
      status: "complete",
      summary: "done",
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      approvedAt: null,
      updatedAt: now,
    }).run();
    db.insert(wizardRuns).values({
      id: "wizard-run-1",
      userId: minimalUser.id,
      modelId: "openai:gpt-5-mini",
      status: "complete",
      summary: "done",
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      approvedAt: null,
      updatedAt: now,
    }).run();

    const service = new AuthService(
      new UserRepository(db),
      new GeneratedImageRepository(db),
      imageStore,
      new AuthEmailService({
        sendgridApiKey: "",
        emailFrom: "noreply@example.com",
        emailFromName: "TracyHill RP",
        exposeAuthCodes: true,
      }),
    );
    const deletion = await service.requestAccountDeletion(minimalUser.id);
    if (!deletion.devVerificationCode) throw new Error("expected delete verification code");
    await service.confirmAccountDeletion({
      deleteToken: deletion.deleteToken,
      code: deletion.devVerificationCode,
    }, minimalUser.id);
    await service.executeAccountDeletion(minimalUser.id, {
      deleteToken: deletion.deleteToken,
    });

    expect(new UserRepository(db).findById(minimalUser.id)).toBeUndefined();
    expect(new UserRepository(db).findById("admin-2")?.username).toBe("second-admin");
    expect(db.select().from(userPreferences).where(eq(userPreferences.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(sessions).where(eq(sessions.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(messages).where(eq(messages.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(generatedImages).where(eq(generatedImages.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(campaigns).where(eq(campaigns.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(promptTemplates).where(eq(promptTemplates.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(db.select().from(wizardRuns).where(eq(wizardRuns.userId, minimalUser.id)).all()).toHaveLength(0);
    expect(fs.existsSync(imageStore.getFilePath("image-1", "image/png"))).toBe(false);
    sqlite.close();
  });

  it("rejects deleting the last admin account at execute time", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const service = createAuthService(db, seeded.imageDir);
    const deletion = await service.requestAccountDeletion(minimalUser.id);
    if (!deletion.devVerificationCode) throw new Error("expected delete verification code");
    await service.confirmAccountDeletion({
      deleteToken: deletion.deleteToken,
      code: deletion.devVerificationCode,
    }, minimalUser.id);
    await expect(service.executeAccountDeletion(minimalUser.id, {
      deleteToken: deletion.deleteToken,
    })).rejects.toMatchObject({ statusCode: 400 });
    sqlite.close();
  });
});
