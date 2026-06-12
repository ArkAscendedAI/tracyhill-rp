import type { RequestHandler } from "express";

export const healthController: RequestHandler = (_req, res) => {
  res.json({
    ok: true,
    service: "tracyhill-rp-v2-api",
    now: new Date().toISOString(),
  });
};
