import type { RequestHandler } from "express";

import {
  createFolderRequestSchema,
  createSessionRequestSchema,
  updateFolderRequestSchema,
  updateSessionRequestSchema,
  updateWorkspacePreferencesRequestSchema,
  workspaceSearchRequestSchema,
} from "@tracyhill-rp/contracts";

import type { WorkspaceService } from "../../domain/workspace/workspaceService";

export function createWorkspaceController(workspace: WorkspaceService) {
  const getState: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.getState(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const createFolder: RequestHandler = (req, res, next) => {
    try {
      const parsed = createFolderRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid folder request" });
        return;
      }
      res.status(201).json(workspace.createFolder(req.session.userId!, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const updateFolder: RequestHandler = (req, res, next) => {
    try {
      const folderId = String(req.params.folderId);
      const parsed = updateFolderRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid folder request" });
        return;
      }
      res.json(workspace.updateFolder(req.session.userId!, folderId, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const deleteFolder: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.deleteFolder(req.session.userId!, String(req.params.folderId)));
    } catch (error) {
      next(error);
    }
  };

  const createSession: RequestHandler = (req, res, next) => {
    try {
      const parsed = createSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid session request" });
        return;
      }
      res.status(201).json(workspace.createSession(req.session.userId!, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const updateSession: RequestHandler = (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId);
      const parsed = updateSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid session request" });
        return;
      }
      res.json(workspace.updateSession(req.session.userId!, sessionId, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const startSessionFromCampaign: RequestHandler = (req, res, next) => {
    try {
      res.status(201).json(workspace.startSessionFromCampaign(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const deleteSession: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.deleteSession(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const restoreSession: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.restoreSession(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const permanentlyDeleteSession: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.permanentlyDeleteSession(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const emptyRecycleBin: RequestHandler = (req, res, next) => {
    try {
      res.json(workspace.emptyRecycleBin(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const updatePreferences: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateWorkspacePreferencesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid preferences request" });
        return;
      }
      res.json(workspace.updatePreferences(req.session.userId!, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const search: RequestHandler = (req, res, next) => {
    try {
      const parsed = workspaceSearchRequestSchema.safeParse({
        query: typeof req.query.q === "string" ? req.query.q : "",
      });
      if (!parsed.success) {
        res.status(400).json({ error: "invalid search request" });
        return;
      }
      res.json(workspace.search(req.session.userId!, parsed.data.query));
    } catch (error) {
      next(error);
    }
  };

  return {
    getState,
    search,
    createFolder,
    updateFolder,
    deleteFolder,
    createSession,
    startSessionFromCampaign,
    updateSession,
    deleteSession,
    restoreSession,
    permanentlyDeleteSession,
    emptyRecycleBin,
    updatePreferences,
  };
}
