import type { RequestHandler } from "express";

import type { UserRepository } from "../../domain/users/userRepository";

export function createRequireAuth(users: UserRepository): RequestHandler {
  return (req, res, next) => {
    if (!req.session.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const user = users.findById(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      res.status(401).json({ error: "authentication required" });
      return;
    }
    next();
  };
}
