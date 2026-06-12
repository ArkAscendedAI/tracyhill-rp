import type { RequestHandler } from "express";

import { createPromptTemplateRequestSchema, updatePromptTemplateRequestSchema } from "@tracyhill-rp/contracts";

import type { PromptTemplateService } from "../../domain/promptTemplates/promptTemplateService";

export function createPromptTemplateController(templates: PromptTemplateService) {
  const list: RequestHandler = (req, res, next) => {
    try {
      res.json(templates.listTemplates(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const create: RequestHandler = (req, res, next) => {
    try {
      const parsed = createPromptTemplateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid prompt template request" });
        return;
      }
      res.status(201).json(templates.createTemplate(req.session.userId!, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const parsed = updatePromptTemplateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid prompt template request" });
        return;
      }
      res.json(templates.updateTemplate(req.session.userId!, String(req.params.templateId), parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const remove: RequestHandler = (req, res, next) => {
    try {
      res.json(templates.deleteTemplate(req.session.userId!, String(req.params.templateId)));
    } catch (error) {
      next(error);
    }
  };

  return { list, create, update, remove };
}
