import { randomUUID } from "node:crypto";

import type { CreatePromptTemplateRequest, UpdatePromptTemplateRequest } from "@tracyhill-rp/contracts";

import { HttpError } from "../../lib/httpError";
import type { UserRepository } from "../users/userRepository";
import { PromptTemplateRepository } from "./promptTemplateRepository";

export class PromptTemplateService {
  constructor(
    private readonly users: UserRepository,
    private readonly templates: PromptTemplateRepository,
  ) {}

  listTemplates(userId: string) {
    this.assertUser(userId);
    return { templates: this.templates.listByUser(userId).map(mapTemplateRow) };
  }

  createTemplate(userId: string, input: CreatePromptTemplateRequest) {
    this.assertUser(userId);
    const now = new Date().toISOString();
    this.templates.create({
      id: randomUUID(),
      userId,
      name: input.name.trim(),
      content: input.content.trim(),
      createdAt: now,
      updatedAt: now,
    });
    return this.listTemplates(userId);
  }

  updateTemplate(userId: string, templateId: string, input: UpdatePromptTemplateRequest) {
    this.assertUser(userId);
    const updated = this.templates.updateForUser(userId, templateId, {
      name: input.name.trim(),
      content: input.content.trim(),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) throw new HttpError(404, "prompt template not found");
    return this.listTemplates(userId);
  }

  deleteTemplate(userId: string, templateId: string) {
    this.assertUser(userId);
    const existing = this.templates.findByUser(userId, templateId);
    if (!existing) throw new HttpError(404, "prompt template not found");
    this.templates.deleteForUser(userId, templateId);
    return this.listTemplates(userId);
  }

  private assertUser(userId: string) {
    if (!this.users.findById(userId)) throw new HttpError(401, "user not found");
  }
}

function mapTemplateRow(row: {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
