import type { RequestHandler } from "express";

import { generateImageRequestSchema } from "@tracyhill-rp/contracts";

import type { ImageService } from "../../domain/images/imageService";
import { firstHeaderValue } from "../../lib/headerUtil";

export function createImageController(images: ImageService) {
  const generate: RequestHandler = async (req, res, next) => {
    const parsed = generateImageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid image request" });
      return;
    }
    try {
      const detail = await images.generateForSession(req.session.userId!, String(req.params.sessionId), parsed.data, firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID());
      res.status(201).json(detail);
    } catch (error) {
      next(error);
    }
  };

  const getImage: RequestHandler = (req, res, next) => {
    try {
      const image = images.loadImage(req.session.userId!, String(req.params.imageId));
      res.setHeader("content-type", image.mimeType);
      res.send(image.bytes);
    } catch (error) {
      next(error);
    }
  };

  return { generate, getImage };
}
