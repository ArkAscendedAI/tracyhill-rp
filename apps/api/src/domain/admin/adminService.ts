import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import type {
  AdminDeleteUserResponse,
  AdminResetUserPasswordRequest,
  AdminResetUserPasswordResponse,
  AdminUpdateUserRoleRequest,
  AdminUpdateUserRoleResponse,
  AdminUser,
  AdminUserSessionDetailResponse,
  AdminUserSessionsResponse,
  AdminUsersResponse,
  CreateAdminUserRequest,
  CreateAdminUserResponse,
} from "@tracyhill-rp/contracts";

import { HttpError } from "../../lib/httpError";
import { createId } from "../../lib/ids";
import { hashPassword, validatePassword, validateUsername } from "../../lib/password";
import { MessageRepository } from "../chat/messageRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { ProviderKeyRepository } from "../providerKeys/providerKeyRepository";
import { UserRepository } from "../users/userRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { UserPreferencesRepository } from "../workspace/userPreferencesRepository";
import type { SqliteSessionStore } from "../../services/sqliteSessionStore";

export class AdminService {
  constructor(
    private readonly users: UserRepository,
    private readonly preferences: UserPreferencesRepository,
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly providerKeys: ProviderKeyRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly dbFile: string,
    private readonly imageDir: string,
    private readonly sessionStore?: SqliteSessionStore,
  ) {}

  getStorage() {
    const disk = readDiskStats(fs.existsSync(this.imageDir) ? this.imageDir : path.dirname(this.dbFile));
    const images = readDirSize(this.imageDir);
    const imageCount = fs.existsSync(this.imageDir)
      ? fs.readdirSync(this.imageDir).filter((entry) => entry.endsWith(".png") || entry.endsWith(".bin")).length
      : 0;
    const users = [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`].reduce((sum, filePath) => sum + readFileSize(filePath), 0);
    return {
      diskTotal: disk.diskTotal,
      diskUsed: disk.diskUsed,
      diskFree: disk.diskFree,
      dataDir: {
        images,
        imageCount,
        users,
        total: images + users,
      },
    };
  }

  purgeImages() {
    const images = this.generatedImages.listAll();
    for (const image of images) this.imageStore.delete(image.id, image.mimeType);
    this.generatedImages.deleteAll();
    return {
      ok: true as const,
      deleted: images.length,
    };
  }

  listUsers(): AdminUsersResponse {
    return {
      users: this.users.listAll().sort((left, right) => left.username.localeCompare(right.username)).map((user) => this.toAdminUser(user.id)),
    };
  }

  async createUser(input: CreateAdminUserRequest): Promise<CreateAdminUserResponse> {
    const username = input.username.trim();
    const usernameError = validateUsername(username);
    if (usernameError) throw new HttpError(400, usernameError);
    const passwordError = validatePassword(input.password);
    if (passwordError) throw new HttpError(400, passwordError);
    if (this.users.findByUsername(username)) throw new HttpError(409, "Username already exists");
    const now = new Date().toISOString();
    const id = createId();
    this.users.createUser({
      id,
      username,
      email: null,
      emailVerified: 0,
      agreedToTerms: 0,
      trustedDevices: "[]",
      role: input.role,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
    });
    this.preferences.ensureForUser(id, now);
    return {
      ok: true,
      user: this.toAdminUser(id),
    };
  }

  deleteUser(actorUserId: string, targetUserId: string): AdminDeleteUserResponse {
    if (actorUserId === targetUserId) throw new HttpError(400, "Cannot delete your own account");
    const user = this.users.findById(targetUserId);
    if (!user) throw new HttpError(404, "User not found");
    if (user.role === "admin" && this.users.countAdmins() <= 1) throw new HttpError(400, "Cannot delete the last admin account");
    for (const image of this.generatedImages.listForUser(targetUserId)) this.imageStore.delete(image.id, image.mimeType);
    this.users.deleteAccount(targetUserId);
    // Invalidate any active HTTP sessions for the deleted user. Stored as JSON
    // in http_sessions.sess, so we scan via the session store rather than the
    // userRepository transaction.
    try { this.sessionStore?.destroyByUserId(targetUserId); } catch { /* best effort */ }
    return { ok: true };
  }

  async resetUserPassword(targetUserId: string, input: AdminResetUserPasswordRequest): Promise<AdminResetUserPasswordResponse> {
    const passwordError = validatePassword(input.password);
    if (passwordError) throw new HttpError(400, passwordError);
    const user = this.users.findById(targetUserId);
    if (!user) throw new HttpError(404, "User not found");
    this.users.updatePasswordHash(targetUserId, await hashPassword(input.password), new Date().toISOString());
    // An admin reset is usually a compromise response: kill the target's live
    // sessions and MFA-bypassing trusted devices (both used to stay valid).
    try { this.sessionStore?.destroyByUserId(targetUserId); } catch { /* best effort */ }
    this.users.updateTrustedDevices(targetUserId, "[]", new Date().toISOString());
    return { ok: true };
  }

  updateUserRole(actorUserId: string, targetUserId: string, input: AdminUpdateUserRoleRequest): AdminUpdateUserRoleResponse {
    if (actorUserId === targetUserId) throw new HttpError(400, "Cannot change your own role");
    const user = this.users.findById(targetUserId);
    if (!user) throw new HttpError(404, "User not found");
    if (user.role === "admin" && input.role !== "admin" && this.users.countAdmins() <= 1) throw new HttpError(400, "Cannot demote the last admin account");
    this.users.updateRole(targetUserId, input.role, new Date().toISOString());
    return {
      ok: true,
      user: this.toAdminUser(targetUserId),
    };
  }

  listUserSessions(targetUserId: string): AdminUserSessionsResponse {
    const user = this.users.findById(targetUserId);
    if (!user) throw new HttpError(404, "User not found");
    return {
      username: user.username,
      sessions: this.sessions.listForUser(targetUserId).map((session) => ({
        id: session.id,
        name: session.name,
        modelId: session.modelId,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        deletedAt: session.deletedAt,
      })),
    };
  }

  getUserSessionDetail(targetUserId: string, sessionId: string): AdminUserSessionDetailResponse {
    const user = this.users.findById(targetUserId);
    if (!user) throw new HttpError(404, "User not found");
    const session = this.sessions.findById(targetUserId, sessionId);
    if (!session) throw new HttpError(404, "Session not found");
    return {
      username: user.username,
      session: {
        id: session.id,
        name: session.name,
        modelId: session.modelId,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        deletedAt: session.deletedAt,
      },
      messages: this.messages.listForSession(targetUserId, sessionId).map((message) => ({
        id: message.id,
        role: message.role as "user" | "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })),
    };
  }

  private toAdminUser(userId: string): AdminUser {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "User not found");
    const keys = this.providerKeys.listByUser(userId);
    return {
      id: user.id,
      username: user.username,
      role: user.role as "admin" | "user",
      createdAt: user.createdAt,
      sessionCount: this.sessions.listForUser(userId).length,
      providerKeys: {
        anthropic: keys.some((key) => key.provider === "anthropic"),
        "claude-code": keys.some((key) => key.provider === "claude-code"),
        deepseek: keys.some((key) => key.provider === "deepseek"),
        google: keys.some((key) => key.provider === "google"),
        openai: keys.some((key) => key.provider === "openai"),
        xai: keys.some((key) => key.provider === "xai"),
        xiaomi: keys.some((key) => key.provider === "xiaomi"),
        zai: keys.some((key) => key.provider === "zai"),
      },
    };
  }
}

function readFileSize(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readDirSize(dirPath: string) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else total += readFileSize(next);
    }
  };
  walk(dirPath);
  return total;
}

function readDiskStats(targetPath: string) {
  try {
    const output = execFileSync("df", ["-B1", targetPath], { encoding: "utf8" });
    const lines = output.trim().split("\n");
    if (lines.length < 2) return { diskTotal: 0, diskUsed: 0, diskFree: 0 };
    const parts = lines[1]?.trim().split(/\s+/) ?? [];
    return {
      diskTotal: Number(parts[1]) || 0,
      diskUsed: Number(parts[2]) || 0,
      diskFree: Number(parts[3]) || 0,
    };
  } catch {
    return { diskTotal: 0, diskUsed: 0, diskFree: 0 };
  }
}
