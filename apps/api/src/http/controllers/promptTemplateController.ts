import type { RequestHandler } from "express";

import { createPromptTemplateRequestSchema, updatePromptTemplateRequestSchema } from "@tracyhill-rp/contracts";

import type { PromptTemplateService } from "../../domain/promptTemplates/promptTemplateService";
import { describeIssues } from "../describeIssues";

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
        // The field and the reason follow the old prefix: a 121-character
        // name or an over-long template used to read only "invalid prompt template request".
        res.status(400).json({ error: `invalid prompt template request: ${describeIssues(parsed.error)}` });
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
        res.status(400).json({ error: `invalid prompt template request: ${describeIssues(parsed.error)}` });
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
