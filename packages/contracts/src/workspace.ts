import { z } from "zod";

import { currentUserSchema } from "./auth";
import { contextSettingsUpdateSchema } from "./context";

export const sessionThinkingModeSchema = z.enum(["off", "enabled", "adaptive"]);
export type SessionThinkingMode = z.infer<typeof sessionThinkingModeSchema>;
export const sessionEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type SessionEffort = z.infer<typeof sessionEffortSchema>;
export const sessionCacheTtlSchema = z.enum(["off", "5m", "1h"]);
export type SessionCacheTtl = z.infer<typeof sessionCacheTtlSchema>;

export const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int().nonnegative(),
  collapsed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Folder = z.infer<typeof folderSchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  sessionType: z.enum(["standard", "wizard"]).default("standard"),
  campaignId: z.string().nullable(),
  folderId: z.string().nullable(),
  modelId: z.string(),
  temperature: z.number().min(0).max(2),
  thinkingMode: sessionThinkingModeSchema,
  thinkingBudget: z.number().int().nullable(),
  effort: sessionEffortSchema.nullable(),
  cacheTtl: sessionCacheTtlSchema,
  autoScroll: z.boolean(),
  pipelineWatermark: z.number().int().nullable(),
  contextOverrides: contextSettingsUpdateSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const workspacePreferencesSchema = z.object({
  activeSessionId: z.string().nullable(),
  sidebarOpen: z.boolean(),
  updatedAt: z.string(),
});

export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;

export const workspaceStateResponseSchema = z.object({
  user: currentUserSchema,
  preferences: workspacePreferencesSchema,
  folders: z.array(folderSchema),
  sessions: z.array(sessionSummarySchema),
});

export type WorkspaceStateResponse = z.infer<typeof workspaceStateResponseSchema>;

export const workspaceSearchResultSchema = z.object({
  type: z.enum(["session", "message"]),
  sessionId: z.string(),
  sessionName: z.string(),
  messageId: z.string().nullable(),
  role: z.enum(["user", "assistant"]).nullable(),
  excerpt: z.string(),
  updatedAt: z.string(),
});

export type WorkspaceSearchResult = z.infer<typeof workspaceSearchResultSchema>;

export const workspaceSearchRequestSchema = z.object({
  query: z.string().trim().max(120),
});

export type WorkspaceSearchRequest = z.infer<typeof workspaceSearchRequestSchema>;

export const workspaceSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(workspaceSearchResultSchema),
});

export type WorkspaceSearchResponse = z.infer<typeof workspaceSearchResponseSchema>;

export const createFolderRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().trim().min(1).max(160).nullable().optional(),
});

export type CreateFolderRequest = z.infer<typeof createFolderRequestSchema>;

export const updateFolderRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().trim().min(1).max(160).nullable().optional(),
  collapsed: z.boolean().optional(),
});

export type UpdateFolderRequest = z.infer<typeof updateFolderRequestSchema>;

export const createSessionRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  sessionType: z.enum(["standard", "wizard"]).default("standard"),
  campaignId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  modelId: z.string().trim().min(1).optional(),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  folderId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  modelId: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinkingMode: sessionThinkingModeSchema.optional(),
  thinkingBudget: z.number().int().min(0).nullable().optional(),
  effort: sessionEffortSchema.nullable().optional(),
  cacheTtl: sessionCacheTtlSchema.optional(),
  autoScroll: z.boolean().optional(),
  contextOverrides: contextSettingsUpdateSchema.optional(),
});

export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateWorkspacePreferencesRequestSchema = z.object({
  activeSessionId: z.string().nullable().optional(),
  sidebarOpen: z.boolean().optional(),
});

export type UpdateWorkspacePreferencesRequest = z.infer<typeof updateWorkspacePreferencesRequestSchema>;

