import type { RequestHandler } from "express";

import { generateImageRequestSchema } from "@tracyhill-rp/contracts";

import type { ImageService } from "../../domain/images/imageService";
import { firstHeaderValue } from "../../lib/headerUtil";
import { describeIssues } from "../describeIssues";

export function createImageController(images: ImageService) {
  const generate: RequestHandler = async (req, res, next) => {
    const parsed = generateImageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // The field and the reason follow the old prefix: Generate image with
      // composer text over 32,000 characters used to read only "invalid image request".
      res.status(400).json({ error: `invalid image request: ${describeIssues(parsed.error)}` });
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
      res.setHeader("content-length", String(image.bytes.byteLength));
      res.setHeader("x-content-type-options", "nosniff");
      // Generated images are immutable per id (a regenerate is a new id), and
      // the route is session-authenticated — cache privately, never shared.
      res.setHeader("cache-control", "private, max-age=86400, immutable");
      res.send(image.bytes);
    } catch (error) {
      next(error);
    }
  };

  return { generate, getImage };
}
