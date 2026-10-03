import type { RequestHandler } from "express";

import type { ModelCatalogResponse } from "@tracyhill-rp/contracts";
import { CHAT_MODELS, EMBEDDING_MODELS, IMAGE_MODELS } from "@tracyhill-rp/model-catalog";

/**
 * GET /api/models: the three catalog arrays as they are, for a
 * client that ships a compiled copy (Android merges this over it). The catalog is fixed for the
 * life of the process, so the body is built once; a signed-in client may reuse it for 5 minutes.
 */
export function createModelCatalogController() {
  const body: ModelCatalogResponse = { chatModels: CHAT_MODELS, imageModels: IMAGE_MODELS, embeddingModels: EMBEDDING_MODELS };
  const get: RequestHandler = (_req, res) => {
    res.setHeader("cache-control", "private, max-age=300");
    res.json(body);
  };
  return { get };
}
