import { z } from "zod";

import { roleSchema } from "./common";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const adminStorageResponseSchema = z.object({
  diskTotal: z.number().nonnegative(),
  diskUsed: z.number().nonnegative(),
  diskFree: z.number().nonnegative(),
  dataDir: z.object({
    images: z.number().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    users: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export type AdminStorageResponse = z.infer<typeof adminStorageResponseSchema>;

export const adminPurgeImagesResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.number().int().nonnegative(),
});

export type AdminPurgeImagesResponse = z.infer<typeof adminPurgeImagesResponseSchema>;

export const adminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  sessionCount: z.number().int().nonnegative(),
  providerKeys: z.object({
    anthropic: z.boolean(),
    "claude-code": z.boolean(),
    deepseek: z.boolean(),
    google: z.boolean(),
    openai: z.boolean(),
    xai: z.boolean(),
    xiaomi: z.boolean(),
    zai: z.boolean(),
  }),
});

export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUsersResponseSchema = z.object({
  users: z.array(adminUserSchema),
});

export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

export const createAdminUserRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: roleSchema.default("user"),
});

export type CreateAdminUserRequest = z.infer<typeof createAdminUserRequestSchema>;

export const createAdminUserResponseSchema = z.object({
  ok: z.literal(true),
  user: adminUserSchema,
});

export type CreateAdminUserResponse = z.infer<typeof createAdminUserResponseSchema>;

export const adminDeleteUserResponseSchema = z.object({
  ok: z.literal(true),
});

export type AdminDeleteUserResponse = z.infer<typeof adminDeleteUserResponseSchema>;

export const adminResetUserPasswordRequestSchema = z.object({
  password: z.string().min(1),
});

export type AdminResetUserPasswordRequest = z.infer<typeof adminResetUserPasswordRequestSchema>;

export const adminResetUserPasswordResponseSchema = z.object({
  ok: z.literal(true),
});

export type AdminResetUserPasswordResponse = z.infer<typeof adminResetUserPasswordResponseSchema>;

export const adminUpdateUserRoleRequestSchema = z.object({
  role: roleSchema,
});

export type AdminUpdateUserRoleRequest = z.infer<typeof adminUpdateUserRoleRequestSchema>;

export const adminUpdateUserRoleResponseSchema = z.object({
  ok: z.literal(true),
  user: adminUserSchema,
});

export type AdminUpdateUserRoleResponse = z.infer<typeof adminUpdateUserRoleResponseSchema>;

export const adminUserSessionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  modelId: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type AdminUserSessionSummary = z.infer<typeof adminUserSessionSummarySchema>;

export const adminUserSessionsResponseSchema = z.object({
  username: z.string(),
  sessions: z.array(adminUserSessionSummarySchema),
});

export type AdminUserSessionsResponse = z.infer<typeof adminUserSessionsResponseSchema>;

export const adminUserSessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});

export type AdminUserSessionMessage = z.infer<typeof adminUserSessionMessageSchema>;

export const adminUserSessionDetailResponseSchema = z.object({
  username: z.string(),
  session: adminUserSessionSummarySchema,
  messages: z.array(adminUserSessionMessageSchema),
});

export type AdminUserSessionDetailResponse = z.infer<typeof adminUserSessionDetailResponseSchema>;

export const adminAuditEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  actorUsername: z.string().nullable(),
  actorRole: roleSchema.nullable(),
  requestId: z.string().nullable(),
  jobId: z.string().nullable(),
  sessionId: z.string().nullable(),
  campaignId: z.string().nullable(),
  runId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), jsonValueSchema),
  createdAt: z.string(),
});

export type AdminAuditEvent = z.infer<typeof adminAuditEventSchema>;

export const adminAuditEventsResponseSchema = z.object({
  events: z.array(adminAuditEventSchema),
});

export type AdminAuditEventsResponse = z.infer<typeof adminAuditEventsResponseSchema>;
